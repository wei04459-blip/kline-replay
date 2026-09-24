export const INITIAL = 10000;
export const FEE = 0.0004;
export const SLIP = 0.0002;
export const BASE = 900;
export const DEFAULT_LEVERAGE = 1;
export const MAX_LEVERAGE = 100;
export const MAINTENANCE_MARGIN_RATE = 0.005;
export const ISOLATED_MARGIN_MODE = 'isolated-v1';
export const WARMUP = 365 * 24 * 60 * 60;
export const LENGTH = 180 * 24 * 60 * 60;
export const CONTEXT = WARMUP;
const WEEK = 7 * 24 * 60 * 60;
const MONDAY_OFFSET = 4 * 24 * 60 * 60; // 1970-01-05 00:00 UTC; Unix epoch was Thursday.
const VALID_TFS = new Set([900, 1800, 2700, 3600, 14400, 86400, WEEK]);

function validLeverage(value) {
  return Number.isInteger(value) && value >= DEFAULT_LEVERAGE && value <= MAX_LEVERAGE;
}

function marginFor(notional, leverage) {
  return notional / leverage;
}

export function maxNotional(balance, percent, leverage = DEFAULT_LEVERAGE) {
  if (!Number.isFinite(balance) || balance < 0 || !Number.isFinite(percent) || percent < 0 || percent > 100 || !validLeverage(leverage))
    throw new Error('可用余额、仓位比例或杠杆倍数无效');
  const budget = balance * percent / 100;
  let amount = Math.floor((budget / (1 / leverage + FEE)) * 100 + 1e-9) / 100;
  while (amount > 0 && amount / leverage + amount * FEE > budget + 1e-9) amount = Math.floor((amount - 0.01) * 100 + 1e-9) / 100;
  return Math.max(0, amount);
}

export function positionLiquidationPrice(position) {
  if (position?.marginMode !== ISOLATED_MARGIN_MODE || ![1, -1].includes(position.side) ||
      ![position.entry, position.qty, position.margin].every(Number.isFinite) ||
      position.entry <= 0 || position.qty <= 0 || position.margin <= 0) return null;
  const denominator = position.qty * (position.side === 1
    ? 1 - MAINTENANCE_MARGIN_RATE - FEE
    : 1 + MAINTENANCE_MARGIN_RATE + FEE);
  const notionalAtEntry = position.qty * position.entry;
  const numerator = position.side === 1
    ? notionalAtEntry - position.margin
    : notionalAtEntry + position.margin;
  if (position.side === 1 && numerator <= 1e-10 * Math.max(notionalAtEntry, position.margin)) return null;
  const price = numerator / denominator;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function withMargin(notional, leverage, entryPrice, side) {
  const positionLike = {side, entry: entryPrice, qty: notional / entryPrice,
    notional, margin: marginFor(notional, leverage), leverage, marginMode: ISOLATED_MARGIN_MODE};
  return {marginMode: ISOLATED_MARGIN_MODE, leverage, margin: positionLike.margin,
    liquidationPrice: positionLiquidationPrice(positionLike)};
}

function candleAt(data, index) {
  if (!Array.isArray(data) || !Number.isInteger(index) || index < 0 || index >= data.length) return null;
  const c = data[index];
  if (!Array.isArray(c) || c.length < 6 || !c.slice(0, 6).every(Number.isFinite)) return null;
  const [time, open, high, low, close, volume] = c;
  if (time < 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return c;
}

function assertCandle(data, index, message = '当前行情数据无效') {
  const c = candleAt(data, index);
  if (!c) throw new Error(message);
  return c;
}

export function intervalStart(timestamp, seconds) {
  if (seconds === WEEK) return Math.floor((timestamp - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
  return Math.floor(timestamp / seconds) * seconds;
}

function formingIndex(session, data) {
  if (!session?.forming15m) return -1;
  const timestamp = session.forming15m[0];
  let low = 0, high = data.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (data[mid]?.[0] < timestamp) low = mid + 1;
    else high = mid;
  }
  return data[low]?.[0] === timestamp ? low : -1;
}

function visibleUpperIndex(session, data) {
  const partialIndex = formingIndex(session, data);
  return partialIndex >= 0 ? partialIndex : session?.cursor;
}

function timeMatchesIndex(time, index, data) {
  return Number.isInteger(time) && time >= 0 && Number.isInteger(index) && index >= 0 && index < data.length &&
    intervalStart(time - 1, BASE) === data[index][0];
}

function indexAtOpen(data, timestamp) {
  let low = 0, high = data.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (data[mid]?.[0] < timestamp) low = mid + 1;
    else high = mid;
  }
  return data[low]?.[0] === timestamp ? low : -1;
}

function latestCompletedIndex(data, start, end, beforeTime) {
  let low = start, high = end + 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (data[mid][0] + BASE <= beforeTime) low = mid + 1;
    else high = mid;
  }
  return Math.max(start - 1, low - 1);
}

export function replayPrice(session, data) {
  if (Number.isFinite(session?.minuteCursorTime)) return session.currentPrice;
  const c = candleAt(data, session?.cursor);
  return c?.[4] ?? null;
}

export function replayTime(session, data) {
  if (Number.isFinite(session?.minuteCursorTime)) return session.minuteCursorTime + 60;
  const c = candleAt(data, session?.cursor);
  return c ? c[0] + BASE : null;
}

export function replayEnded(session, data) {
  if (!validIndexTriplet(session, data)) return true;
  return session.cursor >= session.end && !session.forming15m;
}

function validIndexTriplet(s, data) {
  return s && Array.isArray(data) && Number.isInteger(s.start) && Number.isInteger(s.cursor) && Number.isInteger(s.end) &&
    s.start >= 0 && s.start <= s.cursor && s.cursor <= s.end && s.end < data.length;
}

function optionalPrice(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function optionalPercent(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 50);
}

function storedPercent(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function near(a, b, tolerance = 1e-8) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function marginRecordValid(record, entryPrice, {trade = false} = {}) {
  if (record?.marginMode === undefined)
    return record?.leverage === undefined && record?.margin === undefined && record?.liquidationPrice === undefined &&
      (!trade || record?.isolatedAdjustment === undefined);
  if (record.marginMode !== ISOLATED_MARGIN_MODE || !validLeverage(record.leverage) ||
      !Number.isFinite(record.margin) || record.margin <= 0 || !Number.isFinite(record.notional) || record.notional <= 0 ||
      !near(record.margin, marginFor(record.notional, record.leverage)) || !optionalPriceOrNull(record.liquidationPrice)) return false;
  const expected = positionLiquidationPrice({side: record.side, entry: entryPrice, qty: record.qty ?? record.notional / entryPrice,
    margin: record.margin, marginMode: record.marginMode});
  if (!near(record.qty ?? record.notional / entryPrice, record.notional / entryPrice) ||
      (record.entryFee !== undefined && (!Number.isFinite(record.entryFee) || !near(record.entryFee, record.notional * FEE)))) return false;
  if (expected === null ? record.liquidationPrice !== null : !near(record.liquidationPrice, expected)) return false;
  if (trade) {
    if (!Number.isFinite(record.entryFee) || !Number.isFinite(record.exit) || !Number.isFinite(record.fees) ||
        !Number.isFinite(record.isolatedAdjustment) || record.isolatedAdjustment < 0) return false;
    const exitFee = record.exit * record.qty * FEE;
    const gross = (record.exit - record.entry) * record.qty * record.side;
    const expectedAdjustment = Math.max(0, -record.margin - (gross - exitFee));
    if (!near(record.entryFee, record.notional * FEE) || !near(record.fees, record.entryFee + exitFee) ||
        !near(record.isolatedAdjustment, expectedAdjustment) ||
        !near(record.pnl, gross - record.entryFee - exitFee + expectedAdjustment)) return false;
  }
  return true;
}

function optionalPriceOrNull(value) {
  return value === null || (Number.isFinite(value) && value > 0);
}

function normalizeEntryReason(value) {
  if (typeof value !== 'string') throw new Error('下单理由必须是非空文本，最多2000字');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) throw new Error('下单理由必须是非空文本，最多2000字');
  return trimmed;
}

function optionalSavedEntryReason(value) {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 2000);
}

function protectionsBracket(side, anchor, stop, take) {
  if (!optionalPrice(stop) || !optionalPrice(take)) return false;
  return side === 1
    ? (stop === null || stop < anchor) && (take === null || take > anchor)
    : (take === null || take < anchor) && (stop === null || stop > anchor);
}

export function validateSession(session, symbol, data) {
  if (!session || typeof session !== 'object' || !validIndexTriplet(session, data)) return false;
  if (typeof symbol !== 'string' || session.symbol !== symbol || !symbol || session.version !== 1) return false;
  if (!Object.hasOwn(session, 'position')) return false;
  if (!Number.isFinite(session.balance) || !Array.isArray(session.trades) || !VALID_TFS.has(session.tf)) return false;
  if (![session.start, session.cursor, session.end].every(i => candleAt(data, i))) return false;
  if (Object.hasOwn(session, 'minuteCursorTime')) {
    if (!Number.isInteger(session.minuteCursorTime) || session.minuteCursorTime < 0 || session.minuteCursorTime % 60 !== 0 ||
        !Number.isFinite(session.currentPrice) || session.currentPrice <= 0 || !Object.hasOwn(session, 'forming15m')) return false;
    if (session.forming15m !== null) {
      const forming = session.forming15m, partialIndex = formingIndex(session, data);
      if (!Array.isArray(forming) || !candleAt([forming], 0) || forming[0] % BASE !== 0 || partialIndex !== session.cursor + 1 || partialIndex > session.end ||
          intervalStart(session.minuteCursorTime, BASE) !== forming[0] || session.minuteCursorTime < forming[0] ||
          session.minuteCursorTime + 60 >= forming[0] + BASE || session.currentPrice !== forming[4]) return false;
    } else {
      const current = data[session.cursor];
      if (intervalStart(session.minuteCursorTime, BASE) !== current[0] || session.minuteCursorTime + 60 < current[0] + BASE) return false;
    }
  } else if (session.forming15m !== undefined || session.currentPrice !== undefined) return false;
  const visibleIndex = visibleUpperIndex(session, data);
  if (!Number.isInteger(visibleIndex) || visibleIndex < session.cursor || visibleIndex > session.end) return false;
  const pending = session.pending ?? null;
  if (pending && (session.position || ![1, -1].includes(pending.side) || pending.type !== 'limit' ||
      ![pending.notional, pending.entryPrice].every(Number.isFinite) || !optionalPrice(pending.stop) || !optionalPrice(pending.take) || pending.notional <= 0 ||
      pending.entryPrice <= 0 || !Number.isInteger(pending.placedIndex) ||
      pending.placedIndex < session.start || pending.placedIndex > visibleIndex || typeof pending.id !== 'string' ||
      (pending.placedTime !== undefined && (!timeMatchesIndex(pending.placedTime, pending.placedIndex, data) || pending.placedTime > replayTime(session, data))) ||
      (pending.modifiedTime !== undefined && (!timeMatchesIndex(pending.modifiedTime, pending.modifiedIndex, data) || pending.modifiedTime > replayTime(session, data))) ||
      !optionalSavedEntryReason(pending.entryReason) || !marginRecordValid(pending, pending.entryPrice) ||
      (pending.marginMode === ISOLATED_MARGIN_MODE
        ? pending.margin + pending.notional * FEE > session.balance + 1e-8
        : pending.notional * (1 + FEE) > session.balance + 1e-8) ||
      !protectionsBracket(pending.side, pending.entryPrice, pending.stop, pending.take))) return false;
  if (session.position !== null && session.position !== undefined) {
    const p = session.position;
    if (!p || ![1, -1].includes(p.side) || ![p.entry, p.qty, p.notional, p.entryFee].every(Number.isFinite) ||
        !optionalPrice(p.stop) || !optionalPrice(p.take) || !storedPercent(p.stopPct) || !storedPercent(p.takePct) ||
        !optionalSavedEntryReason(p.entryReason) || p.entry <= 0 || p.qty <= 0 || p.notional <= 0 || p.entryFee < 0 ||
        !Number.isInteger(p.entryIndex) || p.entryIndex < session.start || p.entryIndex > visibleIndex || p.entryIndex > session.end || !candleAt(data, p.entryIndex) ||
        (p.entryTime !== undefined && (!timeMatchesIndex(p.entryTime, p.entryIndex, data) || p.entryTime > replayTime(session, data))) ||
        !marginRecordValid(p, p.entry) || (p.marginMode === ISOLATED_MARGIN_MODE && p.margin > session.balance + 1e-8)) return false;
  }
  if (session.orderHistory !== undefined && (!Array.isArray(session.orderHistory) || !session.orderHistory.every(o => o &&
      ['filled', 'cancelled'].includes(o.status) && ['limit', 'market'].includes(o.type) && typeof o.id === 'string' && [o.side, o.notional, o.entryPrice].every(Number.isFinite) &&
      optionalSavedEntryReason(o.entryReason) && marginRecordValid(o, o.status === 'filled' ? o.fillPrice : o.entryPrice) &&
      (o.placedTime === undefined || timeMatchesIndex(o.placedTime, o.placedIndex, data) && o.placedTime <= replayTime(session, data)) &&
      (o.fillTime === undefined || timeMatchesIndex(o.fillTime, o.fillIndex, data) && o.fillTime <= replayTime(session, data)) &&
      (o.modifiedTime === undefined || Number.isInteger(o.modifiedIndex) && timeMatchesIndex(o.modifiedTime, o.modifiedIndex, data) && o.modifiedTime <= replayTime(session, data)) &&
      [1, -1].includes(o.side) && o.notional > 0 && o.entryPrice > 0 && (o.status !== 'filled' ||
        [o.fillIndex, o.fillPrice].every(Number.isFinite) && o.fillIndex >= session.start && o.fillIndex <= visibleIndex && o.fillPrice > 0) &&
      (o.status !== 'cancelled' || Number.isInteger(o.cancelledIndex) && o.cancelledIndex >= session.start && o.cancelledIndex <= visibleIndex &&
        (o.cancelledTime === undefined || timeMatchesIndex(o.cancelledTime, o.cancelledIndex, data) && o.cancelledTime <= replayTime(session, data)))))) return false;
  return session.trades.every(t => t && optionalSavedEntryReason(t.entryReason) && [t.pnl, t.fees, t.entry, t.exit, t.qty].every(Number.isFinite) &&
    (t.entryTime === undefined || timeMatchesIndex(t.entryTime, t.entryIndex, data) && t.entryTime <= replayTime(session, data)) &&
    (t.exitTime === undefined || timeMatchesIndex(t.exitTime, t.exitIndex, data) && t.exitTime <= replayTime(session, data)) &&
    t.entry > 0 && t.exit > 0 && t.qty > 0 && Number.isInteger(t.entryIndex) && Number.isInteger(t.exitIndex) &&
    t.entryIndex >= session.start && t.entryIndex <= t.exitIndex && t.exitIndex <= visibleIndex &&
    !!candleAt(data, t.entryIndex) && !!candleAt(data, t.exitIndex) && marginRecordValid(t, t.entry, {trade: true}));
}

export function createSession(symbol, data, random = Math.random) {
  if (typeof symbol !== 'string' || !symbol || !Array.isArray(data)) throw new Error('交易品种或行情数据无效');
  if (typeof random !== 'function') throw new Error('随机函数无效');
  const firstCandle = candleAt(data, 0);
  if (!firstCandle) throw new Error('行情数据无效');
  const firstTime = firstCandle[0];
  let first = 0;
  while (first < data.length && (!candleAt(data, first) || data[first][0] < firstTime + WARMUP)) first++;
  const candidates = [];
  let scan = first, end = first;
  for (let start = first; start < data.length; start += 16) {
    if (!candleAt(data, start)) continue;
    const target = data[start][0] + LENGTH;
    while (scan < data.length && data[scan]?.[0] < target) {
      if (candleAt(data, scan)) end = scan;
      scan++;
    }
    if (end > start && data[end][0] + BASE >= target - BASE) candidates.push([start, end]);
  }
  const slots = candidates.length;
  if (slots < 1) throw new Error('历史行情不足：随机练习需要至少365天历史和180天练习区间');
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error('随机数必须在[0, 1)范围内');
  const [start, sessionEnd] = candidates[Math.floor(roll * slots)];
  const session = {version: 1, id: crypto.randomUUID(), symbol, start, cursor: start, end: sessionEnd,
    balance: INITIAL, position: null, pending: null, orderHistory: [], trades: [], tf: 14400, blind: true, ma: false, notes: '', created: new Date().toISOString()};
  if (!validateSession(session, symbol, data)) throw new Error('行情数据范围无效');
  return session;
}

// Aggregate only disclosed base candles. If `from` lands inside an interval,
// include that interval's earlier candles so its OHLC remains truthful.
export function aggregate(data, cursor, seconds, from = 0) {
  if (!Array.isArray(data) || !Number.isInteger(cursor) || cursor < 0 || cursor >= data.length || !VALID_TFS.has(seconds)) return [];
  let first = Number.isInteger(from) ? Math.max(0, Math.min(from, cursor)) : 0;
  const cursorCandle = candleAt(data, cursor);
  if (!cursorCandle) return [];
  const targetStart = intervalStart(cursorCandle[0], seconds);
  while (first > 0) {
    const prev = candleAt(data, first - 1);
    if (!prev || intervalStart(prev[0], seconds) !== intervalStart(candleAt(data, first)?.[0] ?? -1, seconds)) break;
    first--;
  }
  // `from` may be invalid. Move only within the cursor's visible range.
  const out = [];
  for (let i = first; i <= cursor; i++) {
    const c = candleAt(data, i);
    if (!c) continue;
    const time = intervalStart(c[0], seconds);
    if (time > targetStart) continue;
    const p = out.at(-1);
    if (p?.time === time) {
      p.high = Math.max(p.high, c[2]); p.low = Math.min(p.low, c[3]); p.close = c[4]; p.volume += c[5];
    } else out.push({time, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]});
  }
  return out;
}

export function aggregateReplay(session, data, seconds, from = 0) {
  if (!session || !Array.isArray(data) || !VALID_TFS.has(seconds) || !validIndexTriplet(session, data)) return [];
  const out = aggregate(data, session.cursor, seconds, from);
  const forming = session.forming15m;
  if (!forming) return out;
  const time = intervalStart(forming[0], seconds), last = out.at(-1);
  if (last?.time === time) {
    last.high = Math.max(last.high, forming[2]);
    last.low = Math.min(last.low, forming[3]);
    last.close = forming[4];
    last.volume += forming[5];
  } else out.push({time, open: forming[1], high: forming[2], low: forming[3], close: forming[4], volume: forming[5]});
  return out;
}

export function advanceMinute(session, minuteBar, data) {
  if (!validateSession(session, session?.symbol, data)) throw new Error('本轮行情范围无效');
  if (replayEnded(session, data)) return {ended: true, trade: null, orderFilled: null, orderCancelled: null};
  if (!Array.isArray(minuteBar) || !candleAt([minuteBar], 0) || !Number.isInteger(minuteBar[0]) || minuteBar[0] % 60 !== 0)
    throw new Error('分钟行情无效');

  const time = minuteBar[0], previousCloseTime = replayTime(session, data), previousMinute = session.minuteCursorTime;
  if (!Number.isFinite(previousCloseTime) || time < previousCloseTime || (previousMinute !== undefined && time < previousMinute + 60))
    throw new Error('分钟行情重复、逆序或早于已披露时刻');
  const endTime = data[session.end][0] + BASE;
  if (time + 60 > endTime) throw new Error('分钟行情超出本轮范围');

  const parentTime = intervalStart(time, BASE), parentIndex = indexAtOpen(data, parentTime);
  if (parentIndex < session.start || parentIndex > session.end) throw new Error('分钟行情缺少对应15分钟K线');

  // Work on a clone so a bad minute or failed match can never leave half-updated cash/order/cursor state.
  const next = structuredClone(session);
  const beforeIndex = next.cursor;
  const completedBefore = latestCompletedIndex(data, next.start, next.end, time);
  if (completedBefore > next.cursor) next.cursor = completedBefore;
  if (next.forming15m && next.forming15m[0] !== parentTime) next.forming15m = null;
  if (next.cursor >= parentIndex) throw new Error('分钟行情已落在完整K线范围内');

  const oldPartial = next.forming15m;
  next.forming15m = oldPartial
    ? [parentTime, oldPartial[1], Math.max(oldPartial[2], minuteBar[2]), Math.min(oldPartial[3], minuteBar[3]), minuteBar[4], oldPartial[5] + minuteBar[5]]
    : [parentTime, minuteBar[1], minuteBar[2], minuteBar[3], minuteBar[4], minuteBar[5]];
  next.minuteCursorTime = time;
  next.currentPrice = minuteBar[4];
  const eventTime = time + 60, eventIndex = parentIndex;
  const minuteCandle = [...minuteBar];
  const completed15m = time + 60 >= parentTime + BASE;
  if (completed15m) {
    next.cursor = parentIndex;
    next.forming15m = null;
  }
  let trade = null, orderFilled = null, orderCancelled = null, entryBar = false;

  if (next.pending) {
    const pending = next.pending;
    const fillPrice = pendingFillPrice(pending, minuteCandle);
    if (fillPrice !== null) {
      next.pending = null;
      positionAtPrice(next, data, pending.side, pending.notional, fillPrice, pending.stop, pending.take, eventIndex,
        pending.id, pending.entryReason, eventTime, pending.leverage ?? DEFAULT_LEVERAGE, pending.marginMode);
      orderFilled = recordFilledOrder(next, pending, eventIndex, fillPrice, eventTime, next.position);
      entryBar = true;
    }
  }
  if (next.position) trade = exitPositionOnBar(next, data, minuteCandle, eventIndex, entryBar);

  if (next.cursor >= next.end && !next.forming15m) {
    if (next.position) trade = closePosition(next, data, next.currentPrice, '本轮结束', next.cursor);
    if (next.pending) orderCancelled = cancelOrder(next, '本轮结束未成交');
  }
  if (!validateSession(next, next.symbol, data)) throw new Error('分钟推进后状态校验失败');
  Object.assign(session, next);
  const currentTimeframeBoundary = intervalStart(previousCloseTime, session.tf) !== intervalStart(eventTime, session.tf);
  return {ended: replayEnded(session, data), minuteTime: time, replayTime: eventTime, currentPrice: minuteBar[4],
    forming15m: session.forming15m, completed15m, currentTimeframeBoundary, advanced15m: session.cursor - beforeIndex,
    trade, orderFilled, orderCancelled};
}

export function openPosition(s, data, side, notional, stopPct, takePct, entryReason = '', leverage = DEFAULT_LEVERAGE) {
  const normalizedReason = normalizeEntryReason(entryReason);
  if (!validIndexTriplet(s, data)) throw new Error('本轮行情范围无效');
  assertCandle(data, s.cursor);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (![1, -1].includes(side)) throw new Error('下单方向无效');
  if (!Number.isFinite(notional) || notional <= 0 || !optionalPercent(stopPct) || !optionalPercent(takePct) || !validLeverage(leverage))
    throw new Error('请输入有效金额和止盈止损距离（0到50%）；关闭保护请传null');
  if (!Number.isFinite(s.balance) || s.balance < 0 || marginFor(notional, leverage) + notional * FEE > s.balance + 1e-8) throw new Error('保证金加开仓手续费不能超过可用余额');
  const c = assertCandle(data, s.cursor), currentPrice = replayPrice(s, data), entry = currentPrice * (1 + side * SLIP);
  const entryFee = notional * FEE;
  const entryIndex = visibleUpperIndex(s, data);
  s.position = {side, entry, qty: notional / entry, notional, entryFee, entryIndex, ...withMargin(notional, leverage, entry, side),
    stop: stopPct === null ? null : entry * (1 - side * stopPct / 100),
    take: takePct === null ? null : entry * (1 + side * takePct / 100), stopPct, takePct, entryReason: normalizedReason,
    entryTime: replayTime(s, data)};
  s.balance -= entryFee;
  return s.position;
}

function validateOrderPlan(s, side, notional, entryPrice, stopPrice, takePrice, leverage = DEFAULT_LEVERAGE, marginMode = ISOLATED_MARGIN_MODE) {
  if (![1, -1].includes(side)) throw new Error('下单方向无效');
  if (![notional, entryPrice].every(Number.isFinite) || !optionalPrice(stopPrice) || !optionalPrice(takePrice) || notional <= 0 || entryPrice <= 0 || !validLeverage(leverage))
    throw new Error('请输入有效金额和价格');
  if (!protectionsBracket(side, entryPrice, stopPrice, takePrice)) throw new Error('已启用的止损和止盈必须位于计划入场价正确一侧');
  const required = marginMode === ISOLATED_MARGIN_MODE ? marginFor(notional, leverage) + notional * FEE : notional * (1 + FEE);
  if (!Number.isFinite(s.balance) || s.balance < 0 || required > s.balance + 1e-8)
    throw new Error('保证金加开仓手续费不能超过可用余额');
}

function positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, index, orderId = null, entryReason = undefined, entryTime = undefined, leverage = DEFAULT_LEVERAGE, marginMode = null) {
  const entryFee = notional * FEE;
  const position = {side, entry: fillPrice, qty: notional / fillPrice, notional, entryFee, entryIndex: index,
    ...(marginMode === ISOLATED_MARGIN_MODE ? withMargin(notional, leverage, fillPrice, side) : {}),
    stop: stopPrice, take: takePrice,
    stopPct: stopPrice === null ? null : Math.abs((fillPrice - stopPrice) / fillPrice * 100),
    takePct: takePrice === null ? null : Math.abs((takePrice - fillPrice) / fillPrice * 100), orderId,
    entryTime: entryTime ?? (data[index]?.[0] + BASE)};
  if (entryReason !== undefined) position.entryReason = entryReason;
  s.position = position;
  s.balance -= entryFee;
  return position;
}

function recordFilledOrder(s, order, fillIndex, fillPrice, fillTime = undefined, position = null) {
  const record = {...order, ...(position?.marginMode === ISOLATED_MARGIN_MODE ? {marginMode: position.marginMode, leverage: position.leverage,
    margin: position.margin, liquidationPrice: position.liquidationPrice} : {}), status: 'filled', fillIndex, fillPrice, ...(fillTime === undefined ? {} : {fillTime})};
  s.orderHistory ??= [];
  s.orderHistory.push(record);
  return record;
}

// Market orders fill at the already disclosed close. Limit orders stay pending
// until a future observed 15m candle touches their price.
export function placeOrder(s, data, side, notional, entryPrice, stopPrice, takePrice, orderType = 'market', entryReason = '', leverage = DEFAULT_LEVERAGE) {
  const normalizedReason = normalizeEntryReason(entryReason);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (!['market', 'limit'].includes(orderType)) throw new Error('订单类型无效');
  const currentPrice = replayPrice(s, data), eventIndex = visibleUpperIndex(s, data), eventTime = replayTime(s, data);
  const planPrice = orderType === 'market' ? currentPrice : entryPrice;
  validateOrderPlan(s, side, notional, planPrice, stopPrice, takePrice, leverage);
  const order = {id: crypto.randomUUID(), side, notional, entryPrice: planPrice, stop: stopPrice, take: takePrice,
    type: orderType, placedIndex: eventIndex, placedTime: eventTime, entryReason: normalizedReason,
    ...withMargin(notional, leverage, planPrice, side)};
  const marketableLimit = orderType === 'limit' && (side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice);
  if (orderType === 'market' || marketableLimit) {
    const slippedMarket = currentPrice * (1 + side * SLIP);
    const fillPrice = orderType === 'market' ? slippedMarket :
      side === 1 ? Math.min(entryPrice, slippedMarket) : Math.max(entryPrice, slippedMarket);
    // Immediate fills must leave both protections on the correct side of fill.
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    const position = positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, eventIndex, order.id, normalizedReason, eventTime, leverage, ISOLATED_MARGIN_MODE);
    const filled = recordFilledOrder(s, order, eventIndex, fillPrice, eventTime, position);
    return {status: 'filled', order: filled, position};
  }
  const pending = {...order};
  s.pending = pending;
  s.orderHistory ??= [];
  return {status: 'pending', order: pending};
}

export function cancelOrder(s, reason = '用户撤单') {
  if (!s?.pending) return null;
  const cancelledIndex = s.forming15m ? s.cursor + 1 : s.cursor;
  const cancelled = {...s.pending, status: 'cancelled', reason, cancelledIndex,
    ...(Number.isInteger(s.minuteCursorTime) ? {cancelledTime: s.minuteCursorTime + 60} : {})};
  s.orderHistory ??= [];
  s.orderHistory.push(cancelled);
  s.pending = null;
  return cancelled;
}

export function updatePendingOrder(s, data, entryPrice, stopPrice, takePrice) {
  if (!validateSession(s, s?.symbol, data) || !s.pending) throw new Error('当前没有有效挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  validateOrderPlan(s, s.pending.side, s.pending.notional, entryPrice, stopPrice, takePrice, s.pending.leverage ?? DEFAULT_LEVERAGE, s.pending.marginMode);
  const currentPrice = replayPrice(s, data), side = s.pending.side, eventIndex = visibleUpperIndex(s, data), eventTime = replayTime(s, data);
  const updated = {...s.pending, entryPrice, stop: stopPrice, take: takePrice,
    ...(s.pending.marginMode === ISOLATED_MARGIN_MODE ? withMargin(s.pending.notional, s.pending.leverage, entryPrice, s.pending.side) : {}),
    modifiedIndex: eventIndex, modifiedTime: eventTime};
  const marketable = side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice;
  if (marketable) {
    const slippedMarket = currentPrice * (1 + side * SLIP);
    const fillPrice = side === 1 ? Math.min(entryPrice, slippedMarket) : Math.max(entryPrice, slippedMarket);
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    s.pending = null;
    const position = positionAtPrice(s, data, side, updated.notional, fillPrice, stopPrice, takePrice, eventIndex, updated.id, updated.entryReason, eventTime, updated.leverage ?? DEFAULT_LEVERAGE, updated.marginMode);
    const filled = recordFilledOrder(s, updated, eventIndex, fillPrice, eventTime, position);
    return {status: 'filled', order: filled, position};
  }
  s.pending = updated;
  return {status: 'pending', order: s.pending};
}

export function updateProtection(s, data, stopPrice, takePrice) {
  if (!validateSession(s, s?.symbol, data) || !s.position) throw new Error('当前没有有效持仓');
  if (!optionalPrice(stopPrice) || !optionalPrice(takePrice)) throw new Error('保护价格无效；关闭保护请传null');
  const price = replayPrice(s, data), p = s.position;
  if (!protectionsBracket(p.side, price, stopPrice, takePrice)) throw new Error('止盈止损必须分列在当前价格两侧');
  const modifiedIndex = visibleUpperIndex(s, data), modifiedTime = replayTime(s, data);
  let matchedOrder = null;
  if (typeof p.orderId === 'string' && p.orderId.trim() && Array.isArray(s.orderHistory)) {
    const matches = s.orderHistory.filter(order => order?.id === p.orderId && order.status === 'filled');
    if (matches.length > 1) throw new Error('成交订单关联不唯一，无法同步保护价格');
    matchedOrder = matches[0] ?? null;
  }
  p.stop = stopPrice; p.take = takePrice;
  p.stopPct = stopPrice === null ? null : Math.abs((p.entry - stopPrice) / p.entry * 100);
  p.takePct = takePrice === null ? null : Math.abs((takePrice - p.entry) / p.entry * 100);
  if (matchedOrder) {
    matchedOrder.stop = stopPrice;
    matchedOrder.take = takePrice;
    matchedOrder.modifiedIndex = modifiedIndex;
    matchedOrder.modifiedTime = modifiedTime;
  }
  return p;
}

/** Repair legacy snapshots where an active position or closed trade has newer protection than its filled order record. */
export function reconcileOrderProtections(session) {
  if (!session || !Array.isArray(session.orderHistory)) return false;
  const sources = new Map();
  const addSource = (source, priority) => {
    if (!source || typeof source.orderId !== 'string' || !source.orderId.trim() ||
        !Object.hasOwn(source, 'stop') || !Object.hasOwn(source, 'take') ||
        !optionalPrice(source.stop) || !optionalPrice(source.take)) return;
    const current = sources.get(source.orderId);
    if (!current || priority < current.priority) sources.set(source.orderId, {source, priority});
    else if (priority === current.priority && !current.ambiguous &&
        (current.source.stop !== source.stop || current.source.take !== source.take))
      sources.set(source.orderId, {ambiguous: true, priority});
  };
  addSource(session.position, 0);
  if (Array.isArray(session.trades)) for (const trade of session.trades) addSource(trade, 1);

  let changed = false;
  for (const [id, candidate] of sources) {
    if (candidate.ambiguous) continue;
    const records = session.orderHistory.filter(order => order?.id === id && order.status === 'filled');
    if (records.length !== 1) continue;
    const order = records[0], {source} = candidate;
    if (order.stop !== source.stop || order.take !== source.take) {
      order.stop = source.stop;
      order.take = source.take;
      changed = true;
    }
  }
  return changed;
}

function pendingFillPrice(order, candle) {
  if (order.type !== 'limit') throw new Error('仅支持限价挂单');
  const [open, high, low] = [candle[1], candle[2], candle[3]];
  let raw;
  if (order.side === 1 && order.type === 'limit') {
    if (low > order.entryPrice) return null;
    raw = open <= order.entryPrice ? open : order.entryPrice;
    return Math.min(order.entryPrice, raw * (1 + SLIP));
  }
  if (order.side === -1 && order.type === 'limit') {
    if (high < order.entryPrice) return null;
    raw = open >= order.entryPrice ? open : order.entryPrice;
    return Math.max(order.entryPrice, raw * (1 - SLIP));
  }
  return null;
}

function exitPositionOnBar(s, data, c, index, entryBar = false) {
  const p = s.position;
  if (!p) return null;
  const liquidation = p.marginMode === ISOLATED_MARGIN_MODE ? p.liquidationPrice : null;
  const gapLiquidation = Number.isFinite(liquidation) && (p.side === 1 ? c[1] <= liquidation : c[1] >= liquidation);
  if (gapLiquidation) return closePosition(s, data, c[1], '强平', index);
  const gapStop = p.stop !== null && (p.side === 1 ? c[1] <= p.stop : c[1] >= p.stop);
  const hitStop = p.stop !== null && (p.side === 1 ? c[3] <= p.stop : c[2] >= p.stop);
  if (gapStop) return closePosition(s, data, c[1], '跳空止损', index);
  const gapTake = p.take !== null && (p.side === 1 ? c[1] >= p.take : c[1] <= p.take);
  if (!entryBar && gapTake) return closePosition(s, data, c[1], '跳空止盈', index);
  const hitLiquidation = Number.isFinite(liquidation) && (p.side === 1 ? c[3] <= liquidation : c[2] >= liquidation);
  if (hitLiquidation) {
    const stopIsCloser = p.stop !== null && (p.side === 1 ? p.stop >= liquidation : p.stop <= liquidation);
    if (!hitStop || !stopIsCloser) return closePosition(s, data, liquidation, '强平', index);
  }
  if (hitStop) {
    const hitTake = p.take !== null && (p.side === 1 ? c[2] >= p.take : c[3] <= p.take);
    return closePosition(s, data, p.stop, hitTake ? '双触发，按止损' : entryBar ? '入场同根止损' : '止损', index);
  }
  if (entryBar) return null; // Intrabar order is unknown; defer take-profit to the next candle.
  const hitTake = p.take !== null && (p.side === 1 ? c[2] >= p.take : c[3] <= p.take);
  if (hitTake) return closePosition(s, data, p.take, '止盈', index);
  return null;
}

export function closePosition(s, data, price, reason = '手动平仓', index = undefined) {
  if (!s?.position) return null;
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  index ??= visibleUpperIndex(s, data);
  if (price === undefined) price = replayPrice(s, data);
  if (!Number.isFinite(price) || !Number.isInteger(index) || index < s.position.entryIndex || index > visibleUpperIndex(s, data) || index >= data.length || price <= 0) throw new Error('平仓价格或行情索引无效');
  const c = assertCandle(data, index);
  const p = s.position;
  const exit = price * (1 - p.side * SLIP);
  const exitFee = exit * p.qty * FEE;
  const gross = (exit - p.entry) * p.qty * p.side;
  const isolatedAdjustment = p.marginMode === ISOLATED_MARGIN_MODE
    ? Math.max(0, -p.margin - (gross - exitFee)) : 0;
  const settlement = gross - exitFee + isolatedAdjustment;
  const legacyExitTime = c[0] + BASE;
  const trade = {...p, id: crypto.randomUUID(), exit, exitIndex: index,
    exitTime: Number.isInteger(s.minuteCursorTime) ? replayTime(s, data) : legacyExitTime,
    entryTime: p.entryTime ?? assertCandle(data, p.entryIndex)[0] + BASE,
    pnl: settlement - p.entryFee, fees: p.entryFee + exitFee, reason,
    ...(p.marginMode === ISOLATED_MARGIN_MODE ? {isolatedAdjustment} : {})};
  s.balance += settlement;
  s.trades.push(trade);
  s.position = null;
  return trade;
}

// Walk underlying 15m bars in order. At an exact stop/take touch, stop wins;
// gaps fill from the bar open. Playback pauses at the exit for review.
export function advance(s, data) {
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (Object.hasOwn(s, 'minuteCursorTime')) throw new Error('分钟回放状态请使用advanceMinute推进');
  if (s.cursor >= s.end) {
    const orderCancelled = s.pending ? cancelOrder(s, '本轮结束未成交') : null;
    return {ended: true, trade: null, orderFilled: null, orderCancelled};
  }
  if (!VALID_TFS.has(s.tf)) throw new Error('周期无效');
  const current = assertCandle(data, s.cursor);
  const nextBoundary = intervalStart(current[0] + BASE, s.tf) + s.tf;
  let trade = null, orderFilled = null, orderCancelled = null;
  while (s.cursor < s.end) {
    const i = s.cursor + 1;
    const c = assertCandle(data, i);
    s.cursor = i;
    let entryBar = false;
    if (s.pending) {
      const pending = s.pending;
      const fillPrice = pendingFillPrice(pending, c);
      if (fillPrice !== null) {
        s.pending = null;
        const fillTime = c[0] + BASE;
        positionAtPrice(s, data, pending.side, pending.notional, fillPrice, pending.stop, pending.take, i, pending.id, pending.entryReason, fillTime, pending.leverage ?? DEFAULT_LEVERAGE, pending.marginMode);
        orderFilled = recordFilledOrder(s, pending, i, fillPrice, fillTime, s.position);
        entryBar = true;
      }
    }
    if (s.position) trade = exitPositionOnBar(s, data, c, i, entryBar);
    if (trade || orderFilled || c[0] + BASE >= nextBoundary) break;
  }
  if (s.cursor === s.end && s.position) trade = closePosition(s, data, assertCandle(data, s.cursor)[4], '本轮结束', s.cursor);
  if (s.cursor === s.end && s.pending) orderCancelled = cancelOrder(s, '本轮结束未成交');
  return {ended: s.cursor >= s.end, trade, orderFilled, orderCancelled};
}

export function metrics(s, data) {
  if (!validIndexTriplet(s, data)) throw new Error('本轮行情范围无效');
  const p = s.position;
  const price = replayPrice(s, data);
  if (!Number.isFinite(price) || price <= 0) throw new Error('当前披露价格无效');
  const estimatedExit = price * (1 - (p?.side ?? 1) * SLIP);
  const unreal = p ? (estimatedExit - p.entry) * p.qty * p.side - estimatedExit * p.qty * FEE : 0;
  const equity = s.balance + unreal;
  const win = s.trades.filter(t => t.pnl > 0).length;
  const fees = s.trades.reduce((n, t) => n + t.fees, 0) + (p?.entryFee || 0) + (p ? estimatedExit * p.qty * FEE : 0);
  const usedMargin = p ? (p.marginMode === ISOLATED_MARGIN_MODE ? p.margin : p.notional) : 0;
  const reservedMargin = s.pending ? (s.pending.marginMode === ISOLATED_MARGIN_MODE
    ? s.pending.margin + s.pending.notional * FEE : s.pending.notional * (1 + FEE)) : 0;
  return {unreal, equity, pnl: equity - INITIAL, winRate: s.trades.length ? win / s.trades.length * 100 : null, fees,
    availableBalance: s.balance - usedMargin - reservedMargin, usedMargin, reservedMargin,
    liquidationPrice: p?.marginMode === ISOLATED_MARGIN_MODE ? positionLiquidationPrice(p) : null};
}
