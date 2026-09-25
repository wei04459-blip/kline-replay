import test from 'node:test';
import assert from 'node:assert/strict';
import {advance, advanceMinute, aggregate, aggregateReplay, cancelOrder, closePosition, createSession, FEE, INITIAL, intervalStart, LENGTH, MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE, maxNotional, metrics, manualClosePosition, openPosition as engineOpenPosition, placeOrder as enginePlaceOrder, positionLiquidationPrice, reconcileOrderProtections, replayEnded, replayPrice, replayTime, SLIP, updatePendingOrder, updateProtection, validateSession, WARMUP} from '../dist/engine.mjs';

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
  // Simulate a pre-leverage snapshot: legacy positions keep their original uncapped settlement.
  for (const key of ['marginMode', 'leverage', 'margin', 'liquidationPrice']) delete s.position[key];
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

test('live protection updates the exact filled order record through stop, bracket, and removal', () => {
  const data = bars(5), s = session(data);
  const result = placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  const order = s.orderHistory[0], id = order.id, original = {...order};
  assert.equal(order.stop, null);
  assert.equal(order.take, null); // Before a protection edit is confirmed, its filled-order record stays unchanged.

  updateProtection(s, data, 95, null);
  assert.equal(order.id, id);
  assert.equal(order.status, 'filled');
  assert.equal(order.stop, 95);
  assert.equal(order.take, null);
  assert.equal(order.modifiedIndex, 0);
  assert.equal(order.modifiedTime, 900);

  updateProtection(s, data, 95, 105);
  assert.equal(order.stop, 95);
  assert.equal(order.take, 105);
  updateProtection(s, data, null, null);
  assert.equal(order.stop, null);
  assert.equal(order.take, null);
  assert.equal(order.id, original.id);
  assert.equal(order.fillPrice, original.fillPrice);
  assert.equal(order.fillTime, original.fillTime);
  assert.equal(order.entryReason, original.entryReason);
  assert.equal(order.notional, original.notional);
  assert.equal(order.entryPrice, original.entryPrice);
  assert.equal(order.status, original.status);
  assert.equal(s.position.orderId, id);
  assert.equal(s.orderHistory.length, 1);
  assert.equal(s.balance, INITIAL - result.position.entryFee);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('protection synchronization changes only the filled order linked to the current position', () => {
  const data = bars(5), s = session(data);
  const first = placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  closePosition(s, data, undefined, 'finish first');
  const second = placeOrder(s, data, -1, 1000, 100, null, null, 'market');
  const beforeFirst = {...s.orderHistory[0]}, secondId = second.order.id;
  updateProtection(s, data, null, 95);
  assert.equal(s.position.orderId, secondId);
  assert.equal(s.orderHistory[0].id, first.order.id);
  assert.equal(s.orderHistory[0].stop, beforeFirst.stop);
  assert.equal(s.orderHistory[0].take, beforeFirst.take);
  assert.equal(s.orderHistory[0].modifiedTime, beforeFirst.modifiedTime);
  assert.equal(s.orderHistory[1].id, secondId);
  assert.equal(s.orderHistory[1].stop, null);
  assert.equal(s.orderHistory[1].take, 95);
  assert.equal(s.orderHistory[1].modifiedIndex, 0);
  assert.equal(s.orderHistory[1].modifiedTime, 900);
});

test('invalid or ambiguous protection edits leave position and all order records unchanged', () => {
  const data = bars(5), s = session(data);
  placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  const beforeInvalid = JSON.stringify(s);
  assert.throws(() => updateProtection(s, data, 101, null), /当前价格两侧/);
  assert.equal(JSON.stringify(s), beforeInvalid);

  s.orderHistory.push({...s.orderHistory[0]});
  const beforeAmbiguous = JSON.stringify(s);
  assert.throws(() => updateProtection(s, data, 95, null), /关联不唯一/);
  assert.equal(JSON.stringify(s), beforeAmbiguous);
});

test('legacy positions without a matching filled order remain editable without creating history', () => {
  const data = bars(5), s = session(data);
  openPosition(s, data, 1, 1000, null, null);
  updateProtection(s, data, 95, null);
  assert.equal(s.position.stop, 95);
  assert.equal(s.position.take, null);
  assert.equal(s.orderHistory.length, 0);

  s.position.orderId = 'missing-order';
  updateProtection(s, data, null, 105);
  assert.equal(s.position.stop, null);
  assert.equal(s.position.take, 105);
  assert.equal(s.orderHistory.length, 0);
});

test('reconcileOrderProtections repairs only unambiguous filled-order links and is idempotent', () => {
  const data = bars(5), s = session(data);
  const closed = placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  closePosition(s, data, undefined, 'close first');
  const active = placeOrder(s, data, -1, 1000, 100, null, null, 'market');
  // Simulate old saved records where the live position and closed trade had later protection edits.
  s.trades[0].stop = 90; s.trades[0].take = 110;
  s.position.stop = null; s.position.take = 105;
  const firstRecord = s.orderHistory.find(order => order.id === closed.order.id);
  const activeRecord = s.orderHistory.find(order => order.id === active.order.id);
  const closedStable = Object.fromEntries(['id', 'status', 'entryPrice', 'fillPrice', 'fillIndex', 'fillTime', 'entryReason', 'placedTime'].map(key => [key, firstRecord?.[key]]));
  const activeStable = Object.fromEntries(['id', 'status', 'entryPrice', 'fillPrice', 'fillIndex', 'fillTime', 'entryReason', 'placedTime'].map(key => [key, activeRecord?.[key]]));
  assert.equal(firstRecord.stop, null);
  assert.equal(activeRecord.take, null);

  assert.equal(reconcileOrderProtections(s), true);
  assert.equal(firstRecord.stop, 90);
  assert.equal(firstRecord.take, 110);
  assert.equal(activeRecord.stop, null);
  assert.equal(activeRecord.take, 105);
  assert.equal(Object.hasOwn(firstRecord, 'modifiedTime'), false);
  assert.equal(Object.hasOwn(activeRecord, 'modifiedTime'), false);
  for (const [key, value] of Object.entries(closedStable)) assert.equal(firstRecord[key], value);
  for (const [key, value] of Object.entries(activeStable)) assert.equal(activeRecord[key], value);
  activeRecord.stop = 96; activeRecord.take = 110;
  assert.equal(reconcileOrderProtections(s), true);
  assert.equal(activeRecord.stop, null); // A saved null is an intentional protection removal.
  assert.equal(activeRecord.take, 105);
  assert.equal(reconcileOrderProtections(s), false);

  const ambiguous = session(data);
  ambiguous.position = {...s.position, orderId: 'duplicate'};
  ambiguous.orderHistory = [
    {...activeRecord, id: 'duplicate', status: 'filled', stop: 1, take: 2},
    {...activeRecord, id: 'duplicate', status: 'filled', stop: 3, take: 4}
  ];
  const before = JSON.stringify(ambiguous.orderHistory);
  assert.equal(reconcileOrderProtections(ambiguous), false);
  assert.equal(JSON.stringify(ambiguous.orderHistory), before);
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

test('minute replay grows partial OHLCV without leaking the official future 15m candle across all timeframes', () => {
  const monday = 4 * 86400, data = [
    [monday - 900, 100, 101, 99, 100, 10],
    [monday, 100, 999, 1, 900, 9999],
    [monday + 900, 100, 101, 99, 100, 10]
  ];
  const s = session(data, {end: 2});
  const firstMinute = [monday, 100, 110, 95, 108, 3];
  const step = advanceMinute(s, firstMinute, data);
  assert.equal(step.completed15m, false);
  assert.equal(s.cursor, 0);
  assert.equal(s.minuteCursorTime, monday);
  assert.equal(s.currentPrice, 108);
  assert.deepEqual(s.forming15m, [monday, 100, 110, 95, 108, 3]);
  assert.equal(replayPrice(s, data), 108);
  assert.equal(replayTime(s, data), monday + 60);
  for (const tf of [900, 1800, 2700, 3600, 14400, 86400, 604800]) {
    const out = aggregateReplay(s, data, tf, 0);
    assert.equal(out.at(-1).time, intervalStart(monday, tf));
    assert.equal(out.at(-1).close, 108);
    assert.ok(out.at(-1).high < 999);
    assert.ok(out.at(-1).low > 1);
    assert.equal(out.at(-1).volume, 3);
  }
  const sameMinute = JSON.stringify(s);
  assert.throws(() => advanceMinute(s, firstMinute, data), /重复|逆序/);
  assert.equal(JSON.stringify(s), sameMinute);
  assert.throws(() => advance(s, data), /advanceMinute/);
});

test('15m boundary finalizes only after minute close and records same-minute exit exactly', () => {
  const data = bars(4), s = session(data, {end: 3, tf: 900});
  const opened = placeOrder(s, data, 1, 1000, 100, 95, 105, 'market');
  assert.equal(opened.position.entryTime, data[0][0] + 900);
  let result;
  for (let i = 0; i < 14; i++) {
    result = advanceMinute(s, [900 + i * 60, 100, 101, 99, 100, 1], data);
    assert.equal(result.trade, null);
    assert.equal(result.completed15m, false);
  }
  result = advanceMinute(s, [1740, 100, 106, 90, 96, 1], data);
  assert.equal(result.completed15m, true);
  assert.equal(result.currentTimeframeBoundary, true);
  assert.equal(s.cursor, 1);
  assert.equal(s.forming15m, null);
  assert.equal(result.trade.reason, '双触发，按止损');
  assert.equal(result.trade.entryIndex, 0);
  assert.equal(result.trade.exitIndex, 1);
  assert.equal(result.trade.entryTime, 900);
  assert.equal(result.trade.exitTime, 1800);
  assert.equal(replayTime(s, data), 1800);
});

test('15m final minute can fill a pending limit and conservatively stop it on the same minute', () => {
  const data = bars(4), s = session(data, {end: 3, tf: 900});
  const placed = placeOrder(s, data, 1, 1000, 95, 92, null, 'limit');
  assert.equal(placed.status, 'pending');
  for (let i = 0; i < 14; i++) advanceMinute(s, [900 + i * 60, 100, 101, 99, 100, 1], data);
  const result = advanceMinute(s, [1740, 90, 95, 89, 92, 1], data);
  assert.equal(result.completed15m, true);
  assert.ok(result.orderFilled);
  assert.equal(result.orderFilled.fillIndex, 1);
  assert.equal(result.orderFilled.fillTime, 1800);
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(result.trade.entryIndex, 1);
  assert.equal(result.trade.exitIndex, 1);
  assert.equal(result.trade.entryTime, 1800);
  assert.equal(result.trade.exitTime, 1800);
  assert.equal(s.position, null);
});

test('one-minute limit entry that touches both protections exits at the stop conservatively', () => {
  const data = bars(4), s = session(data, {end: 3, tf: 900});
  placeOrder(s, data, 1, 1000, 95, 90, 105, 'limit');
  const result = advanceMinute(s, [900, 100, 110, 89, 100, 5], data);
  assert.ok(result.orderFilled);
  assert.equal(result.trade.reason, '双触发，按止损');
  assert.equal(result.trade.exit, s.trades[0].stop * (1 - SLIP));
  assert.equal(result.trade.entryTime, 960);
  assert.equal(result.trade.exitTime, 960);
  assert.equal(s.position, null);
});

test('minute market orders, metrics, protection and manual close use the latest disclosed minute price and time', () => {
  const data = bars(4), s = session(data, {end: 3});
  advanceMinute(s, [900, 100, 110, 95, 108, 3], data);
  assert.equal(replayPrice(s, data), 108);
  const placed = enginePlaceOrder(s, data, 1, 1000, 108, null, null, 'market', 'minute close');
  assert.equal(placed.position.entry, 108 * (1 + SLIP));
  assert.equal(placed.position.entryIndex, 1);
  assert.equal(placed.position.entryTime, 960);
  assert.ok(metrics(s, data).unreal < 0);
  assert.equal(updateProtection(s, data, 100, null).stop, 100);
  const trade = closePosition(s, data, undefined, 'manual minute close');
  assert.equal(trade.exit, 108 * (1 - SLIP));
  assert.equal(trade.exitIndex, 1);
  assert.equal(trade.exitTime, 960);
  assert.equal(trade.entryTime, 960);
});

test('crossing a missing 1m tail finalizes the closed 15m once then gaps to next real minute open', () => {
  const t = Date.UTC(2023, 2, 24, 12, 15) / 1000;
  const data = [
    [t, 100, 101, 99, 100, 10],
    [t + 900, 100, 101, 99, 100, 100],
    [t + 105 * 60, 80, 85, 75, 82, 20]
  ];
  const s = session(data, {end: 2, tf: 900});
  placeOrder(s, data, 1, 1000, 100, 95, null, 'market');
  for (let i = 0; i < 10; i++) advanceMinute(s, [t + 900 + i * 60, 100, 101, 99, 100, 10], data);
  assert.equal(s.cursor, 0);
  assert.equal(s.forming15m[0], t + 900);
  const result = advanceMinute(s, [t + 105 * 60, 80, 85, 75, 82, 20], data);
  assert.equal(s.cursor, 1); // The known 12:30 15m row is now complete.
  assert.equal(s.forming15m[0], t + 105 * 60); // Start a new partial at 14:00; do not fabricate the gap.
  assert.equal(result.advanced15m, 1);
  assert.equal(result.trade.reason, '跳空止损');
  assert.equal(result.trade.exit, 80 * (1 - SLIP));
  assert.equal(result.trade.exitIndex, 2);
  assert.equal(result.trade.exitTime, t + 105 * 60 + 60);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  const nextRealMinute = advanceMinute(s, [t + 105 * 60 + 60, 82, 84, 81, 83, 5], data);
  assert.equal(nextRealMinute.advanced15m, 0);
  assert.equal(nextRealMinute.trade, null);
  assert.equal(s.cursor, 1);
  const saved = JSON.stringify(s);
  assert.throws(() => advanceMinute(s, [t + 105 * 60, 80, 85, 75, 82, 20], data), /重复|逆序/);
  assert.equal(JSON.stringify(s), saved);
});

test('cancelling a pending order during a partial 15m candle records visible index and exact time', () => {
  const data = bars(4), s = session(data, {end: 3, tf: 900});
  advanceMinute(s, [900, 100, 101, 99, 100, 1], data);
  const placed = placeOrder(s, data, 1, 1000, 90, null, null, 'limit');
  assert.equal(placed.order.placedIndex, 1);
  assert.equal(placed.order.placedTime, 960);
  const cancelled = cancelOrder(s, '撤销计划');
  assert.equal(cancelled.cancelledIndex, 1);
  assert.equal(cancelled.cancelledTime, 960);
  assert.equal(cancelled.reason, '撤销计划');
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  const afterCancel = advanceMinute(s, [960, 100, 110, 80, 90, 1], data);
  assert.equal(afterCancel.orderFilled, null);
  assert.equal(s.pending, null);
  assert.equal(s.orderHistory.at(-1).cancelledIndex, 1);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('old 15m sessions start minute replay after the disclosed close and minute restore remains valid', () => {
  const data = bars(5), legacy = session(data, {end: 4, tf: 900});
  assert.equal(Object.hasOwn(legacy, 'minuteCursorTime'), false);
  assert.equal(replayTime(legacy, data), data[0][0] + 900);
  assert.equal(replayPrice(legacy, data), data[0][4]);
  const first = advanceMinute(legacy, [900, 100, 102, 99, 101, 5], data);
  assert.equal(first.minuteTime, 900);
  assert.equal(first.replayTime, 960);
  assert.equal(validateSession(JSON.parse(JSON.stringify(legacy)), 'BTCUSDT', data), true);
  assert.equal(replayEnded(legacy, data), false);
});

test('minute replay settles once on the final completed 15m and then remains ended', () => {
  const data = bars(3), s = session(data, {end: 1, tf: 900});
  placeOrder(s, data, 1, 1000, 100, null, null, 'market');
  let result;
  for (let i = 0; i < 15; i++) result = advanceMinute(s, [900 + i * 60, 100, 103, 99, 100 + i / 10, 1], data);
  assert.equal(result.ended, true);
  assert.equal(result.completed15m, true);
  assert.equal(s.cursor, 1);
  assert.equal(s.forming15m, null);
  assert.equal(s.position, null);
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].reason, '本轮结束');
  assert.equal(s.trades[0].exitTime, 1800);
  assert.equal(replayEnded(s, data), true);
  const snapshot = JSON.stringify(s);
  assert.equal(advanceMinute(s, [1800, 101, 102, 100, 101, 1], data).ended, true);
  assert.equal(JSON.stringify(s), snapshot);
});

test('pending minute order is cancelled exactly once when the final 15m completes', () => {
  const data = bars(3), s = session(data, {end: 1, tf: 900});
  placeOrder(s, data, 1, 1000, 90, 85, null, 'limit');
  let result;
  for (let i = 0; i < 15; i++) result = advanceMinute(s, [900 + i * 60, 100, 103, 99, 100, 1], data);
  assert.equal(result.ended, true);
  assert.equal(result.orderFilled, null);
  assert.equal(result.orderCancelled.status, 'cancelled');
  assert.equal(result.orderCancelled.cancelledIndex, 1);
  assert.equal(result.orderCancelled.cancelledTime, 1800);
  assert.equal(s.orderHistory.length, 1);
  assert.equal(s.pending, null);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  assert.equal(advanceMinute(s, null, data).ended, true);
  assert.equal(s.orderHistory.length, 1);
});

test('100 percent notional sizing reserves both margin and entry fee and never exceeds the wallet budget', () => {
  for (const leverage of [1, 2, 10, 100]) {
    const amount = maxNotional(INITIAL, 100, leverage);
    assert.ok(amount / leverage + amount * FEE <= INITIAL);
    assert.ok((amount + 0.01) / leverage + (amount + 0.01) * FEE > INITIAL);
    const s = session(bars(3));
    const result = enginePlaceOrder(s, bars(3), 1, amount, 100, null, null, 'market', TEST_ENTRY_REASON, leverage);
    assert.equal(result.status, 'filled');
    assert.ok(metrics(s, bars(3)).availableBalance >= -1e-8);
    assert.ok(Math.abs(metrics(s, bars(3)).usedMargin - amount / leverage) < 1e-8);
    assert.ok(Math.abs(s.balance - (INITIAL - amount * FEE)) < 1e-8); // Margin is locked, not debited twice.
  }
});

test('leverage changes locked margin and liquidation risk, not nominal exposure PnL or fees', () => {
  const data = bars(3);
  const results = [];
  for (const leverage of [2, 10]) {
    const s = session(data);
    enginePlaceOrder(s, data, 1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, leverage);
    const p = s.position;
    assert.equal(p.leverage, leverage);
    assert.equal(p.marginMode, 'isolated-v1');
    assert.ok(Math.abs(p.margin - 1000 / leverage) < 1e-10);
    assert.ok(Math.abs(s.balance - (INITIAL - 1000 * FEE)) < 1e-10);
    assert.equal(p.liquidationPrice, positionLiquidationPrice(p));
    assert.ok(metrics(s, data).availableBalance >= 0);
    s.cursor = 1;
    results.push(closePosition(s, data, 110, 'test', 1));
  }
  assert.ok(Math.abs(results[0].pnl - results[1].pnl) < 1e-10);
  assert.ok(Math.abs(results[0].fees - results[1].fees) < 1e-10);
});

test('leverage input is an integer from 1 to 100 and rejects atomically', () => {
  for (const leverage of [0, 101, 1.5, NaN, '2']) {
    const data = bars(3), s = session(data), before = structuredClone(s);
    assert.throws(() => enginePlaceOrder(s, data, 1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, leverage));
    assert.deepEqual(s, before);
    assert.throws(() => engineOpenPosition(s, data, 1, 1000, null, null, TEST_ENTRY_REASON, leverage));
    assert.deepEqual(s, before);
  }
  assert.equal(maxNotional(INITIAL, 100, MAX_LEVERAGE) > 0, true);
});

test('marketable limits fill at actual price but retain leverage and reprice preview liquidation', () => {
  const data = bars(3), s = session(data);
  const result = enginePlaceOrder(s, data, -1, 1200, 90, null, null, 'limit', TEST_ENTRY_REASON, 6);
  assert.equal(result.status, 'filled');
  assert.equal(result.position.leverage, 6);
  assert.equal(result.order.leverage, 6);
  assert.equal(result.order.liquidationPrice, positionLiquidationPrice(result.position));
  assert.notEqual(result.order.liquidationPrice, positionLiquidationPrice({...result.position, entry: result.order.entryPrice}));
  assert.equal(validateSession(s, 'BTCUSDT', data), true);
});

test('pending orders reserve margin and fee, release on cancel, and transfer reservation on fill', () => {
  const data = bars(4), s = session(data);
  const before = s.balance;
  placeOrder(s, data, 1, 2000, 90, null, null, 'limit');
  s.pending.leverage = 5;
  Object.assign(s.pending, {marginMode: 'isolated-v1', margin: 400,
    liquidationPrice: positionLiquidationPrice({side: 1, entry: 90, qty: 2000 / 90, margin: 400, marginMode: 'isolated-v1'})});
  assert.equal(metrics(s, data).reservedMargin, 400 + 2000 * FEE);
  assert.equal(s.balance, before);
  cancelOrder(s);
  assert.equal(s.balance, before);
  assert.equal(metrics(s, data).reservedMargin, 0);
  assert.equal(metrics(s, data).availableBalance, before);

  const f = session(data);
  enginePlaceOrder(f, data, 1, 2000, 90, null, null, 'limit', TEST_ENTRY_REASON, 5);
  const oldCash = f.balance;
  const result = advanceMinute(f, [900, 90, 91, 88, 90, 2], data);
  assert.equal(result.orderFilled.leverage, 5);
  assert.equal(f.position.leverage, 5);
  assert.equal(f.balance, oldCash - 2000 * FEE);
  assert.equal(metrics(f, data).reservedMargin, 0);
  assert.equal(metrics(f, data).usedMargin, 400);
  assert.equal(validateSession(JSON.parse(JSON.stringify(f)), 'BTCUSDT', data), true);
});

test('isolated liquidation uses estimated maintenance and close fee threshold and ignores float dust at 1x', () => {
  const nonInteger = {side: 1, entry: 123.4567, qty: 321.987 / 123.4567, margin: 321.987, marginMode: 'isolated-v1'};
  assert.equal(positionLiquidationPrice(nonInteger), null);
  const long = {side: 1, entry: 123.4567, qty: 321.987 / 123.4567, margin: 321.987 / 4, marginMode: 'isolated-v1'};
  const short = {...long, side: -1};
  const expectedLong = (long.qty * long.entry - long.margin) / (long.qty * (1 - MAINTENANCE_MARGIN_RATE - FEE));
  const expectedShort = (short.qty * short.entry + short.margin) / (short.qty * (1 + MAINTENANCE_MARGIN_RATE + FEE));
  assert.ok(Math.abs(positionLiquidationPrice(long) - expectedLong) < 1e-10);
  assert.ok(Math.abs(positionLiquidationPrice(short) - expectedShort) < 1e-10);
  assert.equal(positionLiquidationPrice({side: 1, entry: 100, qty: 10, margin: 1000}), null); // Legacy has no inferred liquidation line.
});

test('isolated liquidation gap caps loss to margin without consuming unused wallet funds', () => {
  const data = bars(3), s = session(data, {tf: 900});
  enginePlaceOrder(s, data, -1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, 2);
  const openingFee = s.position.entryFee, margin = s.position.margin;
  const liq = s.position.liquidationPrice;
  data[1] = [900, liq * 2, liq * 2.1, liq * 1.9, liq * 2, 5];
  const result = advance(s, data);
  const trade = result.trade;
  assert.equal(trade.reason, '强平');
  assert.ok(trade.isolatedAdjustment > 0);
  assert.ok(Math.abs(s.balance - (INITIAL - margin - openingFee)) < 1e-7);
  assert.ok(Math.abs(s.balance - (INITIAL + trade.pnl)) < 1e-7);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('manual closing execution cannot charge an isolated loss beyond its margin', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, 1, 2400, 100, null, null, 'market', TEST_ENTRY_REASON, 3);
  const margin = s.position.margin, entryFee = s.position.entryFee, liq = s.position.liquidationPrice;
  const trade = closePosition(s, data, liq / 2, '手动平仓', 0);
  assert.equal(trade.reason, '手动平仓');
  assert.ok(trade.isolatedAdjustment > 0);
  assert.ok(Math.abs(trade.pnl + margin + entryFee) < 1e-7);
  assert.ok(Math.abs(s.balance - (INITIAL - margin - entryFee)) < 1e-7);
});

test('intrabar stop versus liquidation takes the nearer threshold, and gap liquidation beats a distant stop', () => {
  const data = bars(4);
  const nearStop = session(data);
  enginePlaceOrder(nearStop, data, 1, 1000, 100, 60, null, 'market', TEST_ENTRY_REASON, 2);
  data[1] = [900, 100, 105, 45, 90, 1];
  assert.equal(advance(nearStop, data).trade.reason, '止损');

  const liqFirst = session(bars(4));
  enginePlaceOrder(liqFirst, bars(4), 1, 1000, 100, 40, null, 'market', TEST_ENTRY_REASON, 2);
  const liq = liqFirst.position.liquidationPrice;
  const liqData = bars(4);
  liqData[1] = [900, 100, 105, liq - 1, 90, 1];
  const out = advance(liqFirst, liqData);
  assert.equal(out.trade.reason, '强平');

  const gap = session(bars(4));
  enginePlaceOrder(gap, bars(4), 1, 1000, 100, 40, null, 'market', TEST_ENTRY_REASON, 2);
  const gapData = bars(4);
  gapData[1] = [900, gap.position.liquidationPrice - 10, gap.position.liquidationPrice, gap.position.liquidationPrice - 20, gap.position.liquidationPrice - 5, 1];
  assert.equal(advance(gap, gapData).trade.reason, '强平');
});

test('legacy pending records stay uncapped through repricing and fill, including extreme short loss', () => {
  const data = bars(4), s = session(data);
  placeOrder(s, data, -1, 9990, 110, null, null, 'limit');
  for (const key of ['marginMode', 'leverage', 'margin', 'liquidationPrice']) delete s.pending[key];
  assert.equal(validateSession(s, 'BTCUSDT', data), true);
  updatePendingOrder(s, data, 105, null, null);
  assert.equal(Object.hasOwn(s.pending, 'marginMode'), false);
  data[1] = [900, 105, 106, 104, 105, 1];
  const result = advance(s, data);
  assert.equal(result.orderFilled.status, 'filled');
  assert.equal(Object.hasOwn(s.position, 'marginMode'), false);
  assert.equal(Object.hasOwn(result.orderFilled, 'marginMode'), false);
  data[2] = [1800, 400, 410, 390, 400, 1];
  s.end = 2;
  s.cursor = 1;
  const trade = advance(s, data).trade;
  assert.equal(trade.reason, '本轮结束');
  assert.ok(s.balance < 0);
  assert.equal(Object.hasOwn(trade, 'isolatedAdjustment'), false);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('saved isolated positions and minute recovery retain leverage and liquidation accounting', () => {
  const data = bars(4), s = session(data);
  enginePlaceOrder(s, data, -1, 1500, 100, null, null, 'market', TEST_ENTRY_REASON, 3);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(validateSession(restored, 'BTCUSDT', data), true);
  const result = advanceMinute(restored, [900, 100, 102, 99, 101, 1], data);
  assert.equal(result.trade, null);
  assert.equal(restored.position.leverage, 3);
  assert.equal(restored.position.margin, 500);
  assert.equal(restored.trades.length, 0);
});

test('protection edits preserve isolated accounting and mirror only the linked filled order', () => {
  const data = bars(3), s = session(data);
  const {position, order} = enginePlaceOrder(s, data, 1, 1600, 100, null, null, 'market', TEST_ENTRY_REASON, 4);
  const margin = position.margin, liquidationPrice = position.liquidationPrice;
  updateProtection(s, data, 90, null);
  assert.equal(s.orderHistory[0].id, order.id);
  assert.equal(s.orderHistory[0].stop, 90);
  assert.equal(s.orderHistory[0].take, null);
  assert.equal(s.orderHistory[0].margin, margin);
  assert.equal(s.orderHistory[0].liquidationPrice, liquidationPrice);
  assert.equal(position.margin, margin);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
});

test('saved isolated accounting rejects altered leverage, margin, quantity, fee, or liquidation estimate', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, -1, 1800, 100, null, null, 'market', TEST_ENTRY_REASON, 3);
  for (const [key, value] of [['leverage', 1.5], ['margin', 1], ['qty', s.position.qty + 1], ['entryFee', 99], ['liquidationPrice', 1]]) {
    const corrupt = structuredClone(s);
    corrupt.position[key] = value;
    assert.equal(validateSession(corrupt, 'BTCUSDT', data), false, `must reject ${key}`);
  }
});

test('saved isolated trade validator recomputes entry fee, exit fee, and exact margin adjustment', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, 1, 1500, 100, null, null, 'market', TEST_ENTRY_REASON, 2);
  const p = s.position;
  closePosition(s, data, p.liquidationPrice / 2, '测试极端成交', 0);
  const saved = JSON.parse(JSON.stringify(s));
  const t = saved.trades[0];
  assert.ok(t.isolatedAdjustment > 0);
  assert.equal(validateSession(saved, 'BTCUSDT', data), true);

  const adjustmentTamper = structuredClone(saved);
  adjustmentTamper.trades[0].isolatedAdjustment += 100;
  adjustmentTamper.trades[0].pnl += 100;
  assert.equal(validateSession(adjustmentTamper, 'BTCUSDT', data), false);

  const missingEntryFee = structuredClone(saved);
  delete missingEntryFee.trades[0].entryFee;
  assert.equal(validateSession(missingEntryFee, 'BTCUSDT', data), false);

  const feeTamper = structuredClone(saved);
  feeTamper.trades[0].fees = 0;
  feeTamper.trades[0].pnl = (feeTamper.trades[0].exit - feeTamper.trades[0].entry) * feeTamper.trades[0].qty * feeTamper.trades[0].side + feeTamper.trades[0].isolatedAdjustment;
  assert.equal(validateSession(feeTamper, 'BTCUSDT', data), false);
});

test('short intrabar liquidation caps isolated loss, while minute liquidation is timestamped and recoverable', () => {
  const data = bars(4), s = session(data, {tf: 900});
  enginePlaceOrder(s, data, -1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, 2);
  const entryFee = s.position.entryFee, margin = s.position.margin, liq = s.position.liquidationPrice;
  const saved = JSON.parse(JSON.stringify(s));
  const minuteData = bars(4);
  const event = advanceMinute(saved, [900, liq + 10, liq + 15, liq + 5, liq + 12, 3], minuteData);
  assert.equal(event.trade.reason, '强平');
  assert.equal(event.trade.exitTime, 960);
  assert.ok(event.trade.isolatedAdjustment > 0);
  assert.ok(Math.abs(saved.balance - (INITIAL - margin - entryFee)) < 1e-7);
  assert.equal(validateSession(JSON.parse(JSON.stringify(saved)), 'BTCUSDT', minuteData), true);
});

test('manual close requires a trimmed explanation and preserves exit, entry, and system reasons separately', () => {
  for (const side of [1, -1]) {
    const data = bars(3), s = session(data);
    enginePlaceOrder(s, data, side, 1800, 100, null, null, 'market', `entry-${side}`, 4);
    const trade = manualClosePosition(s, data, '  结构失效，按计划退出  ', side === 1 ? 110 : 90, 0);
    assert.equal(trade.reason, '手动平仓');
    assert.equal(trade.exitReason, '结构失效，按计划退出');
    assert.equal(trade.entryReason, `entry-${side}`);
    assert.equal(trade.leverage, 4);
    assert.equal(trade.isolatedAdjustment, 0);
    assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  }
});

test('invalid manual close reasons fail atomically without changing position or ledger', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, 1, 1200, 100, null, null, 'market', TEST_ENTRY_REASON, 2);
  for (const reason of ['', '  \n ', null, 123, 'x'.repeat(2001)]) {
    const before = structuredClone(s);
    assert.throws(() => manualClosePosition(s, data, reason));
    assert.deepEqual(s, before);
  }
});

test('manual exit reasons validate when present while legacy trades without the field still restore', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, -1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, 3);
  manualClosePosition(s, data, '风控计划调整', 95, 0);
  assert.equal(validateSession(JSON.parse(JSON.stringify(s)), 'BTCUSDT', data), true);
  for (const reason of ['', '   ', 1, 'x'.repeat(2001)]) {
    const corrupt = structuredClone(s);
    corrupt.trades[0].exitReason = reason;
    assert.equal(validateSession(corrupt, 'BTCUSDT', data), false);
  }
  const legacy = structuredClone(s);
  delete legacy.trades[0].exitReason;
  assert.equal(validateSession(legacy, 'BTCUSDT', data), true);
});

test('legacy positions can use required manual close reasons without acquiring leverage metadata', () => {
  const data = bars(3), s = session(data);
  enginePlaceOrder(s, data, -1, 900, 100, null, null, 'market', TEST_ENTRY_REASON, 1);
  for (const record of [s.position, ...s.orderHistory])
    for (const key of ['marginMode', 'leverage', 'margin', 'liquidationPrice']) delete record[key];
  assert.equal(validateSession(s, 'BTCUSDT', data), true);
  const trade = manualClosePosition(s, data, '旧仓位主动退出', 98, 0);
  assert.equal(trade.exitReason, '旧仓位主动退出');
  assert.equal(trade.reason, '手动平仓');
  assert.equal(Object.hasOwn(trade, 'marginMode'), false);
  const restored = structuredClone(s);
  delete restored.trades[0].exitReason;
  assert.equal(validateSession(restored, 'BTCUSDT', data), true);
});

test('automatic stop, liquidation, and end-of-session closes do not require or invent a manual exit reason', () => {
  const stopData = bars(3), stop = session(stopData);
  enginePlaceOrder(stop, stopData, 1, 1000, 100, 99, null, 'market', TEST_ENTRY_REASON, 2);
  stopData[1] = [900, 100, 101, 98, 100, 1];
  const stopped = advance(stop, stopData).trade;
  assert.equal(stopped.reason, '止损');
  assert.equal(Object.hasOwn(stopped, 'exitReason'), false);

  const liqData = bars(3), liq = session(liqData);
  enginePlaceOrder(liq, liqData, 1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, 2);
  liqData[1] = [900, 100, 101, liq.position.liquidationPrice - 1, 100, 1];
  const liquidated = advance(liq, liqData).trade;
  assert.equal(liquidated.reason, '强平');
  assert.equal(Object.hasOwn(liquidated, 'exitReason'), false);

  const endData = bars(3), end = session(endData, {end: 1});
  enginePlaceOrder(end, endData, -1, 1000, 100, null, null, 'market', TEST_ENTRY_REASON, 3);
  const ended = advance(end, endData).trade;
  assert.equal(ended.reason, '本轮结束');
  assert.equal(Object.hasOwn(ended, 'exitReason'), false);
});
