import test from 'node:test';
import assert from 'node:assert/strict';
import {advance, aggregate, cancelOrder, closePosition, createSession, FEE, INITIAL, LENGTH, metrics, openPosition as engineOpenPosition, placeOrder as enginePlaceOrder, SLIP, updatePendingOrder, updateProtection, validateSession, WARMUP} from '../dist/engine.mjs';

const TEST_ENTRY_REASON = '测试入场理由';
function openPosition(...args) { return engineOpenPosition(...args, TEST_ENTRY_REASON); }
function placeOrder(...args) { return enginePlaceOrder(...args, TEST_ENTRY_REASON); }

function bars(count, {start = 0, price = 100} = {}) {
  return Array.from({length: count}, (_, i) => [start + i * 900, price, price + 1, price - 1, price, 10]);
}
function session(data, {start = 0, end = data.length - 1, tf = 14400} = {}) {
  return {version: 1, id: 'test', symbol: 'BTCUSDT', start, cursor: start, end, balance: INITIAL,
    position: null, pending: null, orderHistory: [], trades: [], tf, blind: true, ma: false, notes: ''};
}

test('higher-timeframe candles contain only disclosed bars', () => {
  const data = bars(8);
  data[4] = [3600, 100, 999, 1, 900, 10];
  const visible = aggregate(data, 3, 3600);
  assert.deepEqual(visible, [{time: 0, open: 100, high: 101, low: 99, close: 100, volume: 40}]);
  const next = aggregate(data, 4, 3600);
  assert.equal(next.length, 2);
  assert.equal(next[1].high, 999);
});

test('from inside an interval rewinds to its first base candle', () => {
  const data = bars(16);
  data[4] = [3600, 100, 111, 99, 105, 2];
  const tail = aggregate(data, 7, 3600, 6);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].open, 100);
  assert.equal(tail[0].high, 111);
  assert.equal(tail[0].volume, 32);
});

test('45-minute bars use epoch-aligned boundaries', () => {
  const data = bars(8);
  const out = aggregate(data, 5, 2700);
  assert.deepEqual(out.map(x => x.time), [0, 2700]);
  assert.equal(out[0].volume, 30);
  assert.equal(out[1].volume, 30);
});

test('weekly bars start Monday at 00:00 UTC, despite Unix epoch Thursday', () => {
  const monday = 4 * 86400;
  const data = [
    [monday - 900, 100, 101, 99, 100, 10],
    [monday, 100, 101, 99, 100, 10]
  ];
  const out = aggregate(data, 1, 604800);
  assert.deepEqual(out.map(x => x.time), [monday - 7 * 86400, monday]);
});

test('advance crosses successive timeframe boundaries without skipping bars', () => {
  const data = bars(40);
  const s = session(data, {tf: 14400});
  assert.equal(advance(s, data).trade, null);
  assert.equal(s.cursor, 15); // 00:00 candle closes at 00:15; bar 15 closes at 04:00.
  s.tf = 2700;
  advance(s, data);
  assert.equal(s.cursor, 17); // 45-minute buckets are epoch-aligned; next boundary is 04:30.
});

test('long and short accounting include symmetric slippage and both fees', () => {
  for (const {side, exitPrice} of [{side: 1, exitPrice: 110}, {side: -1, exitPrice: 90}]) {
    const data = bars(2);
    const s = session(data);
    openPosition(s, data, side, 1000, 20, 20);
    s.cursor = 1;
    const p = s.position;
    const trade = closePosition(s, data, exitPrice, 'test', 1);
    const expectedEntry = 100 * (1 + side * SLIP);
    const expectedExit = exitPrice * (1 - side * SLIP);
    const expectedQty = 1000 / expectedEntry;
    const expectedFees = 1000 * FEE + expectedExit * expectedQty * FEE;
    const expectedPnl = (expectedExit - expectedEntry) * expectedQty * side - expectedFees;
    assert.equal(p.entry, expectedEntry);
    assert.ok(Math.abs(trade.pnl - expectedPnl) < 1e-10);
    assert.ok(Math.abs(trade.fees - expectedFees) < 1e-10);
    assert.ok(Math.abs(s.balance - (INITIAL + trade.pnl)) < 1e-10);
    assert.ok(Math.abs(metrics(s, data).pnl - trade.pnl) < 1e-10);
  }
});

test('open short loss can leave negative cash without invalidating the saved result', () => {
  const data = bars(3);
  const s = session(data, {end: 2});
  openPosition(s, data, -1, 9990, 40, 40);
  s.cursor = 1;
  const trade = closePosition(s, data, 300, 'extreme gap', 1);
  assert.ok(s.balance < 0);
  assert.equal(validateSession(s, 'BTCUSDT', data), true);
  assert.throws(() => openPosition(s, data, 1, 1, 5, 5), /可用余额/);
  assert.ok(Math.abs(s.balance - (INITIAL + trade.pnl)) < 1e-8);
});

test('gap stop fills at open and pauses playback on exit candle', () => {
  const data = bars(5);
  const s = session(data, {end: 2});
  openPosition(s, data, 1, 1000, 5, 5);
  data[1] = [900, 90, 92, 89, 91, 10];
  const result = advance(s, data);
  assert.equal(s.cursor, 1);
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(result.trade.exit, 90 * (1 - SLIP));
});

test('a missing 15m interval is not fabricated and next observed open handles the gap', () => {
  const data = bars(5);
  data[1] = [5400, 90, 92, 89, 91, 10]; // three-hour gap from the prior candle
  const s = session(data, {tf: 3600});
  openPosition(s, data, 1, 1000, 5, 5);
  const result = advance(s, data);
  assert.equal(s.cursor, 1);
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(result.trade.exit, 90 * (1 - SLIP));
});

test('same-bar stop and take trigger resolves to the stop', () => {
  const data = bars(5);
  const s = session(data);
  openPosition(s, data, -1, 1000, 5, 5);
  data[1] = [900, 100, 110, 90, 100, 10];
  const result = advance(s, data);
  assert.equal(result.trade.reason, '双触发，按止损');
  assert.equal(result.trade.exit, s.trades[0].stop * (1 + SLIP));
});

test('existing positions honor a take-profit gap at open before later intrabar stop touches', () => {
  for (const {side, open, high, low} of [
    {side: 1, open: 110, high: 115, low: 90},
    {side: -1, open: 90, high: 110, low: 85}
  ]) {
    const data = bars(3), s = session(data, {tf: 900});
    openPosition(s, data, side, 1000, 5, 5);
    data[1] = [900, open, high, low, open, 10];
    const result = advance(s, data);
    assert.equal(result.trade.reason, '跳空止盈');
    assert.equal(result.trade.exit, open * (1 - side * SLIP));
  }
});

test('automatic exits pause, resume advances, and session end closes any position', () => {
  const data = bars(20);
  const s = session(data, {end: 4, tf: 1800});
  openPosition(s, data, 1, 1000, 1, 20);
  data[1] = [900, 100, 100, 97, 99, 10];
  const first = advance(s, data);
  assert.equal(first.trade.reason, '止损');
  assert.equal(s.cursor, 1);
  assert.equal(advance(s, data).trade, null);
  assert.equal(s.cursor, 3);
  openPosition(s, data, -1, 1000, 20, 20);
  const ended = advance(s, data);
  assert.equal(s.cursor, 4);
  assert.equal(ended.ended, true);
  assert.equal(ended.trade.reason, '本轮结束');
  assert.equal(s.position, null);
  assert.equal(s.trades.length, 2);
  assert.ok(Math.abs(s.balance - (INITIAL + s.trades.reduce((sum, t) => sum + t.pnl, 0))) < 1e-9);
});

test('random session range includes the final valid slot and rejects invalid random values', () => {
  const count = Math.ceil((WARMUP + LENGTH) / 900) + 16;
  const data = bars(count);
  const first = createSession('BTCUSDT', data, () => 0);
  const last = createSession('BTCUSDT', data, () => 0.999999999);
  assert.equal(data[first.start][0], WARMUP);
  assert.ok(last.end < data.length);
  assert.ok(last.start > first.start);
  assert.throws(() => createSession('BTCUSDT', data, () => 1), /随机数/);
  assert.throws(() => createSession('BTCUSDT', bars(17472), () => 0), /历史行情不足/);
});

test('saved session validator rejects index, balance, symbol, trade, and position corruption', () => {
  const data = bars(10);
  const good = session(data, {end: 9});
  assert.equal(validateSession(good, 'BTCUSDT', data), true);
  for (const mutate of [
    x => { x.cursor = x.end + 1; },
    x => { x.start = -1; },
    x => { x.end = data.length; },
    x => { x.balance = NaN; },
    x => { x.trades = [{pnl: NaN}]; },
    x => { x.position = {side: 1, entry: 100, qty: NaN, notional: 100, entryFee: 1, stop: 90, take: 110, stopPct: 10, takePct: 10, entryIndex: 0}; }
  ]) {
    const corrupt = structuredClone(good);
    mutate(corrupt);
    assert.equal(validateSession(corrupt, 'BTCUSDT', data), false);
  }
  assert.equal(validateSession(good, 'ETHUSDT', data), false);
});

test('order and candle boundaries reject invalid values cleanly', () => {
  const data = bars(3);
  const s = session(data, {end: 2});
  for (const args of [[0, 100, 2, 2], [1, 0, 2, 2], [1, 100, 0, 2], [1, 100, 2, 50]])
    assert.throws(() => openPosition(s, data, ...args));
  data[0] = [0, NaN, 101, 99, 100, 10];
  assert.throws(() => openPosition(s, data, 1, 100, 2, 2), /行情数据无效/);
});

test('market orders fill at the disclosed close with adverse slip, without replaying that candle', () => {
  const data = bars(4);
  const s = session(data, {tf: 900});
  const result = placeOrder(s, data, 1, 1000, 999, 95, 110, 'market');
  assert.equal(result.status, 'filled');
  assert.equal(result.position.entryIndex, 0);
  assert.equal(result.position.entry, 100 * (1 + SLIP));
  assert.equal(s.balance, INITIAL - 1000 * FEE);
  data[0] = [0, 100, 120, 80, 100, 10]; // The disclosed candle is not replayed after a market fill.
  assert.equal(advance(s, data).trade, null);
  assert.equal(s.cursor, 1);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  const invalid = session(data);
  assert.throws(() => placeOrder(invalid, data, 1, 1000, 100, 99, 100.01, 'market'), /实际成交价两侧/);
  assert.equal(invalid.position, null);
  assert.equal(invalid.balance, INITIAL);
});

test('marketable limit buys and sells fill immediately at current close with slippage capped by the limit', () => {
  for (const {side, limit, stop, take, expected} of [
    {side: 1, limit: 100.01, stop: 95, take: 110, expected: 100.01},
    {side: -1, limit: 99.99, stop: 105, take: 90, expected: 99.99}
  ]) {
    const data = bars(3), s = session(data);
    const result = placeOrder(s, data, side, 1000, limit, stop, take, 'limit');
    assert.equal(result.status, 'filled');
    assert.equal(result.order.type, 'limit');
    assert.equal(result.position.entryIndex, s.cursor);
    assert.equal(result.position.entry, expected);
    assert.equal(s.pending, null);
    assert.ok(side === 1 ? result.position.entry <= limit : result.position.entry >= limit);
    assert.equal(s.balance, INITIAL - 1000 * FEE);
  }
});

test('marketable limits wider than spread still fill at slipped close and validate protection against actual fill', () => {
  const buyData = bars(3), buy = session(buyData);
  assert.equal(placeOrder(buy, buyData, 1, 1000, 105, 95, 110, 'limit').position.entry, 100 * (1 + SLIP));
  const sellData = bars(3), sell = session(sellData);
  assert.equal(placeOrder(sell, sellData, -1, 1000, 95, 105, 90, 'limit').position.entry, 100 * (1 - SLIP));

  const invalidData = bars(3), constrained = session(invalidData);
  assert.throws(() => placeOrder(constrained, invalidData, 1, 1000, 105, 104, 110, 'limit'), /实际成交价两侧/);
  assert.equal(constrained.position, null);
  assert.equal(constrained.pending, null);
  assert.equal(constrained.balance, INITIAL);
});

test('limit orders wait for a future bar, fill at their limit, and update without changing order type', () => {
  const data = bars(5);
  const s = session(data, {tf: 900});
  const placed = placeOrder(s, data, 1, 1000, 95, 90, 105, 'limit');
  assert.equal(placed.status, 'pending');
  assert.equal(s.pending.type, 'limit');
  assert.equal(s.balance, INITIAL);
  data[1] = [900, 100, 101, 96, 100, 10];
  assert.equal(advance(s, data).orderFilled, null);
  assert.equal(s.cursor, 1);
  updatePendingOrder(s, data, 94, 90, 105);
  assert.equal(s.pending.type, 'limit');
  data[2] = [1800, 100, 101, 93, 95, 10];
  const result = advance(s, data);
  assert.equal(result.orderFilled.fillIndex, 2);
  assert.equal(result.orderFilled.fillPrice, 94);
  assert.equal(s.position.entryIndex, 2);
  assert.equal(s.position.entry, 94);
  assert.equal(s.balance, INITIAL - 1000 * FEE);
  assert.equal(validateSession(s, 'BTCUSDT', data), true);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('repricing pending limits across market fills immediately for long and short', () => {
  for (const {side, initial, revised, stop, take, expected} of [
    {side: 1, initial: 90, revised: 101, stop: 95, take: 110, expected: 100 * (1 + SLIP)},
    {side: -1, initial: 110, revised: 99, stop: 105, take: 90, expected: 100 * (1 - SLIP)}
  ]) {
    const data = bars(4), s = session(data);
    const placed = placeOrder(s, data, side, 1000, initial, side === 1 ? 85 : 115, side === 1 ? 95 : 105, 'limit');
    const id = placed.order.id, placedIndex = placed.order.placedIndex;
    const result = updatePendingOrder(s, data, revised, stop, take);
    assert.equal(result.status, 'filled');
    assert.equal(result.order.id, id);
    assert.equal(result.order.placedIndex, placedIndex);
    assert.equal(result.order.modifiedIndex, s.cursor);
    assert.equal(result.order.fillIndex, s.cursor);
    assert.equal(result.position.entry, expected);
    assert.equal(result.position.orderId, id);
    assert.equal(s.pending, null);
    assert.equal(s.orderHistory[0].status, 'filled');
    assert.equal(s.balance, INITIAL - 1000 * FEE);
    assert.equal(validateSession(s, 'BTCUSDT', data), true);
  }
});

test('invalid marketable reprice leaves the original pending order byte-for-byte unchanged', () => {
  const data = bars(4), s = session(data);
  placeOrder(s, data, 1, 1000, 90, 85, 95, 'limit');
  const before = JSON.stringify(s.pending), balance = s.balance;
  assert.throws(() => updatePendingOrder(s, data, 105, 104, 110), /实际成交价两侧/);
  assert.equal(JSON.stringify(s.pending), before);
  assert.equal(s.position, null);
  assert.equal(s.balance, balance);
  assert.equal(s.orderHistory.length, 0);
});

test('limit gap improves price but crossing the stop closes on the same bar with both fees', () => {
  const data = bars(4);
  const s = session(data, {tf: 900});
  const before = s.balance;
  placeOrder(s, data, 1, 1000, 95, 90, 110, 'limit');
  data[1] = [900, 90, 99, 89, 92, 10]; // gap below both limit and stop
  const result = advance(s, data);
  assert.equal(result.orderFilled.fillPrice, Math.min(95, 90 * (1 + SLIP)));
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(s.position, null);
  assert.equal(s.orderHistory[0].status, 'filled');
  assert.equal(s.trades[0].exit, 90 * (1 - SLIP));
  assert.ok(s.balance < before);
  assert.ok(Math.abs(s.balance - (INITIAL + s.trades[0].pnl)) < 1e-8);
});

test('limit entry-bar stop is checked conservatively but take-profit waits until the next bar', () => {
  const data = bars(5);
  const s = session(data, {tf: 900});
  placeOrder(s, data, 1, 1000, 95, 90, 105, 'limit');
  data[1] = [900, 100, 110, 94, 107, 10];
  const first = advance(s, data);
  assert.ok(first.orderFilled);
  assert.equal(first.trade, null); // Take was touched on the ambiguous entry bar.
  assert.ok(s.position);
  data[2] = [1800, 108, 109, 107, 108, 10];
  assert.equal(advance(s, data).trade.reason, '跳空止盈');

  const stopData = bars(3), stopSession = session(stopData, {tf: 900});
  placeOrder(stopSession, stopData, 1, 1000, 95, 90, 110, 'limit');
  stopData[1] = [900, 100, 103, 89, 98, 10];
  const stopped = advance(stopSession, stopData);
  assert.ok(stopped.orderFilled);
  assert.equal(stopped.trade.reason, '入场同根止损');
});

test('short limit gap improves sell price and symmetric stop protection closes the same bar', () => {
  const data = bars(3), s = session(data, {tf: 900});
  placeOrder(s, data, -1, 1000, 105, 110, 100, 'limit');
  data[1] = [900, 112, 115, 111, 113, 10];
  const result = advance(s, data);
  assert.ok(result.orderFilled);
  assert.equal(result.orderFilled.fillPrice, Math.max(105, 112 * (1 - SLIP)));
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(s.position, null);
  assert.ok(Math.abs(s.balance - (INITIAL + result.trade.pnl)) < 1e-8);
});

test('cancelling an unfilled limit keeps an auditable record and charges no fee', () => {
  const data = bars(5), s = session(data, {end: 2});
  placeOrder(s, data, 1, 1000, 90, 85, 100, 'limit');
  const balance = s.balance;
  const cancelled = cancelOrder(s, '改计划');
  assert.equal(cancelled.reason, '改计划');
  assert.equal(s.pending, null);
  assert.equal(s.balance, balance);
  assert.equal(s.orderHistory[0].status, 'cancelled');
  assert.equal(validateSession(s, 'BTCUSDT', data), true);

  placeOrder(s, data, 1, 1000, 90, 85, 100, 'limit');
  data[1] = [900, 100, 101, 95, 100, 10];
  const ended = advance(s, data);
  assert.equal(ended.orderCancelled.reason, '本轮结束未成交');
  assert.equal(s.pending, null);
  assert.equal(s.orderHistory.at(-1).status, 'cancelled');
  assert.equal(s.balance, balance);
});

test('live protection can lock profit but must bracket the current disclosed price', () => {
  const data = bars(5), s = session(data);
  openPosition(s, data, 1, 1000, 10, 20);
  data[0] = [0, 100, 111, 99, 110, 10];
  const p = updateProtection(s, data, 105, 120);
  assert.equal(p.stop, 105); // Above entry is allowed when it remains below current price.
  assert.throws(() => updateProtection(s, data, 111, 120), /当前价格两侧/);
  assert.throws(() => updateProtection(s, data, 105, 110), /当前价格两侧/);
});

test('market orders allow independent stop/take protection, including both disabled, for long and short', () => {
  for (const side of [1, -1]) {
    for (const [stop, take, disabledSide] of [
      [side === 1 ? 95 : 105, null, 'take'],
      [null, side === 1 ? 105 : 95, 'stop'],
      [null, null, 'both']
    ]) {
      const data = bars(4), s = session(data, {tf: 900});
      const result = placeOrder(s, data, side, 1000, 100, stop, take, 'market');
      assert.equal(result.status, 'filled');
      assert.equal(s.position.stop, stop);
      assert.equal(s.position.take, take);
      assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);

      data[1] = side === 1 ? [900, 100, 110, 90, 100, 10] : [900, 100, 110, 90, 100, 10];
      const exited = advance(s, data).trade;
      if (disabledSide === 'both') assert.equal(exited, null);
      else if (disabledSide === 'take') assert.match(exited?.reason || '', /止损/);
      else assert.match(exited?.reason || '', /止盈/);
    }
  }
});

test('limit orders fill and replay only the enabled protection, including no protection', () => {
  const cases = [
    {side: 1, stop: 90, take: null, candle: [900, 100, 105, 89, 95, 10], reason: /止损/},
    {side: 1, stop: null, take: 105, candle: [900, 100, 106, 94, 104, 10], reason: 'take'},
    {side: -1, stop: 110, take: null, candle: [900, 100, 111, 95, 105, 10], reason: /止损/},
    {side: -1, stop: null, take: 95, candle: [900, 100, 105, 94, 96, 10], reason: 'take'},
    {side: 1, stop: null, take: null, candle: [900, 100, 120, 80, 100, 10], reason: null}
  ];
  for (const {side, stop, take, candle, reason} of cases) {
    const data = bars(4), s = session(data, {tf: 900});
    const limit = side === 1 ? 95 : 105;
    const plannedStop = stop === null ? null : (side === 1 ? Math.min(stop, 94) : Math.max(stop, 106));
    const plannedTake = take === null ? null : (side === 1 ? Math.max(take, 96) : Math.min(take, 104));
    const placed = placeOrder(s, data, side, 1000, limit, plannedStop, plannedTake, 'limit');
    assert.equal(placed.status, 'pending');
    data[1] = candle;
    const result = advance(s, data);
    assert.ok(result.orderFilled);
    if (reason === 'take') {
      data[2] = side === 1 ? [1800, 106, 108, 105, 107, 10] : [1800, 94, 95, 92, 93, 10];
      assert.match(advance(s, data).trade?.reason || '', /止盈/);
      assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
      continue;
    }
    if (reason) assert.match(result.trade?.reason || '', reason);
    else assert.equal(result.trade, null);
    assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  }
});

test('pending order protection edits accept null independently and reject bad values atomically', () => {
  for (const side of [1, -1]) {
    const data = bars(4), s = session(data);
    const entry = side === 1 ? 90 : 110;
    const stop = side === 1 ? 85 : 115, take = side === 1 ? 95 : 105;
    placeOrder(s, data, side, 1000, entry, stop, take, 'limit');
    const changed = updatePendingOrder(s, data, entry, null, take);
    assert.equal(changed.status, 'pending');
    assert.equal(s.pending.stop, null);
    assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
    const before = JSON.stringify(s.pending);
    assert.throws(() => updatePendingOrder(s, data, entry, 0, take));
    assert.throws(() => updatePendingOrder(s, data, entry, undefined, take));
    assert.throws(() => updatePendingOrder(s, data, entry, NaN, take));
    assert.equal(JSON.stringify(s.pending), before);
  }
});

test('live protection can independently be disabled or enabled without partial mutation', () => {
  for (const side of [1, -1]) {
    const data = bars(5), s = session(data);
    openPosition(s, data, side, 1000, 10, 20);
    const validStop = side === 1 ? 90 : 110;
    const validTake = side === 1 ? 110 : 90;
    updateProtection(s, data, validStop, null);
    assert.equal(s.position.stop, validStop);
    assert.equal(s.position.take, null);
    updateProtection(s, data, null, validTake);
    assert.equal(s.position.stop, null);
    assert.equal(s.position.take, validTake);
    updateProtection(s, data, null, null);
    assert.equal(s.position.stop, null);
    assert.equal(s.position.take, null);
    assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
    const before = JSON.stringify(s.position);
    assert.throws(() => updateProtection(s, data, 0, validTake));
    assert.throws(() => updateProtection(s, data, validStop, undefined));
    assert.equal(JSON.stringify(s.position), before);
  }
});

test('saved positions accept break-even and wide trailing protection after entry', () => {
  for (const side of [1, -1]) {
    const data = bars(3), s = session(data);
    openPosition(s, data, side, 1000, 5, 5);
    const favorable = side === 1 ? 120 : 80;
    data[0] = [0, favorable, favorable + 1, favorable - 1, favorable, 10];
    updateProtection(s, data, s.position.entry, side === 1 ? 160 : 40);
    assert.equal(s.position.stopPct, 0);
    assert.ok(s.position.takePct > 50);
    assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  }
});

test('unprotected positions survive volatile bars and still support manual and end-of-session close', () => {
  const data = bars(4), s = session(data, {end: 2, tf: 900});
  placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  data[1] = [900, 100, 150, 50, 100, 10];
  assert.equal(advance(s, data).trade, null);
  assert.ok(s.position);
  const manual = closePosition(s, data, undefined, 'manual');
  assert.equal(manual.reason, 'manual');
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);

  const ending = session(data, {end: 1, tf: 900});
  placeOrder(ending, data, -1, 1000, 100, null, null, 'market');
  const result = advance(ending, data);
  assert.equal(result.trade.reason, '本轮结束');
  assert.equal(ending.position, null);
});

test('disabled protection does not fire on opposite-side gaps while enabled protection still does', () => {
  for (const side of [1, -1]) {
    const stopData = bars(4), stopSession = session(stopData, {tf: 900});
    const stop = side === 1 ? 95 : 105;
    placeOrder(stopSession, stopData, side, 1000, 100, stop, null, 'market');
    // Open gaps through the disabled take side, but not through the enabled stop.
    stopData[1] = side === 1 ? [900, 110, 112, 108, 110, 10] : [900, 90, 92, 88, 90, 10];
    assert.equal(advance(stopSession, stopData).trade, null);
    stopData[2] = side === 1 ? [1800, 94, 96, 93, 95, 10] : [1800, 106, 107, 104, 105, 10];
    assert.equal(advance(stopSession, stopData).trade.reason, '跳空止损');

    const takeData = bars(4), takeSession = session(takeData, {tf: 900});
    const take = side === 1 ? 105 : 95;
    placeOrder(takeSession, takeData, side, 1000, 100, null, take, 'market');
    // Open gaps through the disabled stop side, but not through the enabled take.
    takeData[1] = side === 1 ? [900, 90, 92, 88, 90, 10] : [900, 110, 112, 108, 110, 10];
    assert.equal(advance(takeSession, takeData).trade, null);
    takeData[2] = side === 1 ? [1800, 106, 108, 104, 107, 10] : [1800, 94, 96, 92, 93, 10];
    assert.equal(advance(takeSession, takeData).trade.reason, '跳空止盈');
  }
});

test('saved states preserve legacy numeric protection and accept explicit null but reject zero or missing values', () => {
  const data = bars(5), s = session(data, {end: 4});
  openPosition(s, data, 1, 1000, 5, 5);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  s.position.stop = null;
  s.position.stopPct = null;
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  for (const bad of [0, undefined, NaN, Infinity]) {
    const corrupt = structuredClone(s);
    corrupt.position.take = bad;
    assert.equal(validateSession(corrupt, 'BTCUSDT', data), false);
  }
  const pending = session(data, {end: 4});
  placeOrder(pending, data, 1, 1000, 90, null, 95, 'limit');
  assert.equal(validateSession(JSON.parse(JSON.stringify(pending)), 'BTCUSDT', data), true);
  for (const bad of [0, undefined, NaN]) {
    const corrupt = structuredClone(pending);
    corrupt.pending.stop = bad;
    assert.equal(validateSession(corrupt, 'BTCUSDT', data), false);
  }
});

test('immediate fills reject enabled protection on the wrong side but accept disabled side atomically', () => {
  for (const [side, stop, take] of [[1, null, 100.01], [-1, 105, 99.99]]) {
    const data = bars(3), s = session(data);
    const balance = s.balance;
    assert.throws(() => placeOrder(s, data, side, 1000, 100, stop, take, 'market'), /实际成交价/);
    assert.equal(s.position, null);
    assert.equal(s.balance, balance);
    assert.equal(s.orderHistory.length, 0);
  }
});

test('market and direct position entry trim and preserve entry reasons separately from exit reason', () => {
  const data = bars(4), s = session(data);
  const market = enginePlaceOrder(s, data, 1, 1000, 100, null, null, 'market', '  breakout retest  ');
  assert.equal(market.order.entryReason, 'breakout retest');
  assert.equal(market.position.entryReason, 'breakout retest');
  const trade = closePosition(s, data, undefined, 'manual close');
  assert.equal(trade.entryReason, 'breakout retest');
  assert.equal(trade.reason, 'manual close');
  assert.equal(s.orderHistory[0].entryReason, 'breakout retest');
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);

  const direct = session(data);
  const p = engineOpenPosition(direct, data, -1, 500, null, null, '  direct api reason ');
  assert.equal(p.entryReason, 'direct api reason');
  assert.equal(closePosition(direct, data, undefined, 'stop button').entryReason, 'direct api reason');
});

test('marketable limit and pending limit preserve the submitted reason through reprice, fill, and close', () => {
  const marketableData = bars(4), marketable = session(marketableData);
  const immediate = enginePlaceOrder(marketable, marketableData, -1, 1000, 99.99, null, null, 'limit', '  marketable thesis  ');
  assert.equal(immediate.order.entryReason, 'marketable thesis');
  assert.equal(immediate.position.entryReason, 'marketable thesis');

  const data = bars(5), s = session(data, {tf: 900});
  const pending = enginePlaceOrder(s, data, 1, 1000, 95, 90, null, 'limit', 'support bounce');
  assert.equal(pending.status, 'pending');
  assert.equal(s.pending.entryReason, 'support bounce');
  data[1] = [900, 100, 101, 96, 100, 10];
  assert.equal(advance(s, data).orderFilled, null);
  const changed = updatePendingOrder(s, data, 94, 89, null);
  assert.equal(changed.status, 'pending');
  assert.equal(s.pending.entryReason, 'support bounce');
  data[2] = [1800, 100, 101, 93, 95, 10];
  const fill = advance(s, data);
  assert.equal(fill.orderFilled.entryReason, 'support bounce');
  assert.equal(s.position.entryReason, 'support bounce');
  assert.equal(s.orderHistory[0].entryReason, 'support bounce');
  const trade = closePosition(s, data, undefined, 'manual close');
  assert.equal(trade.entryReason, 'support bounce');
  assert.equal(trade.reason, 'manual close');
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('cancelled orders keep entry reason distinct from cancellation reason', () => {
  const data = bars(4), s = session(data);
  enginePlaceOrder(s, data, 1, 1000, 90, null, 95, 'limit', '  oversold setup ');
  const cancelled = cancelOrder(s, 'changed mind');
  assert.equal(cancelled.entryReason, 'oversold setup');
  assert.equal(cancelled.reason, 'changed mind');
  assert.equal(s.orderHistory[0].entryReason, 'oversold setup');
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('blank, nonstring, and overlong entry reasons reject all fresh entry APIs without mutation', () => {
  const invalid = ['', '  \n\t ', null, 5, 'x'.repeat(2001)];
  for (const reason of invalid) {
    const orderData = bars(4), orderSession = session(orderData);
    const before = JSON.stringify(orderSession);
    assert.throws(() => enginePlaceOrder(orderSession, orderData, 1, 1000, 100, null, null, 'market', reason), /下单理由/);
    assert.equal(JSON.stringify(orderSession), before);

    const positionData = bars(4), positionSession = session(positionData);
    const positionBefore = JSON.stringify(positionSession);
    assert.throws(() => engineOpenPosition(positionSession, positionData, 1, 1000, null, null, reason), /下单理由/);
    assert.equal(JSON.stringify(positionSession), positionBefore);
  }
});

test('legacy trades and pending orders without entryReason remain manageable and fill without failure', () => {
  const data = bars(5), legacy = session(data, {tf: 900});
  legacy.pending = {id: 'legacy-order', side: 1, notional: 1000, entryPrice: 95, stop: null, take: null, type: 'limit', placedIndex: 0};
  legacy.orderHistory.push({...legacy.pending, status: 'cancelled', reason: 'old record', cancelledIndex: 0});
  legacy.trades.push({pnl: 1, fees: 1, entry: 100, exit: 101, qty: 1, entryIndex: 0, exitIndex: 0, reason: 'legacy close'});
  assert.equal(validateSession(legacy, 'BTCUSDT', data), true);
  assert.equal(updatePendingOrder(legacy, data, 94, null, null).status, 'pending');
  data[1] = [900, 100, 101, 93, 95, 10];
  const result = advance(legacy, data);
  assert.equal(result.orderFilled.id, 'legacy-order');
  assert.equal(Object.hasOwn(legacy.position, 'entryReason'), false);
  assert.equal(validateSession(JSON.parse(JSON.stringify(legacy)), 'BTCUSDT', data), true);
  const closed = closePosition(legacy, data, undefined, 'legacy manual close');
  assert.equal(Object.hasOwn(closed, 'entryReason'), false);
  assert.equal(closed.reason, 'legacy manual close');
  assert.equal(validateSession(JSON.parse(JSON.stringify(legacy)), 'BTCUSDT', data), true);
});
