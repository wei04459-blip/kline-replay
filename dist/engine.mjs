export const INITIAL = 10000;
export const FEE = 0.0004;
export const SLIP = 0.0002;
export const BASE = 900;
export const WARMUP = 365 * 24 * 60 * 60;
export const LENGTH = 180 * 24 * 60 * 60;
export const CONTEXT = WARMUP;
const WEEK = 7 * 24 * 60 * 60;
const MONDAY_OFFSET = 4 * 24 * 60 * 60; // 1970-01-05 00:00 UTC; Unix epoch was Thursday.
const VALID_TFS = new Set([900, 1800, 2700, 3600, 14400, 86400, WEEK]);

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

function intervalStart(timestamp, seconds) {
  if (seconds === WEEK) return Math.floor((timestamp - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
  return Math.floor(timestamp / seconds) * seconds;
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
  const pending = session.pending ?? null;
  if (pending && (session.position || ![1, -1].includes(pending.side) || pending.type !== 'limit' ||
      ![pending.notional, pending.entryPrice].every(Number.isFinite) || !optionalPrice(pending.stop) || !optionalPrice(pending.take) || pending.notional <= 0 ||
      pending.entryPrice <= 0 || !Number.isInteger(pending.placedIndex) ||
      pending.placedIndex < session.start || pending.placedIndex > session.cursor || typeof pending.id !== 'string' ||
      !optionalSavedEntryReason(pending.entryReason) ||
      pending.notional * (1 + FEE) > session.balance + 1e-8 ||
      !protectionsBracket(pending.side, pending.entryPrice, pending.stop, pending.take))) return false;
  if (session.position !== null && session.position !== undefined) {
    const p = session.position;
    if (!p || ![1, -1].includes(p.side) || ![p.entry, p.qty, p.notional, p.entryFee].every(Number.isFinite) ||
        !optionalPrice(p.stop) || !optionalPrice(p.take) || !storedPercent(p.stopPct) || !storedPercent(p.takePct) ||
        !optionalSavedEntryReason(p.entryReason) || p.entry <= 0 || p.qty <= 0 || p.notional <= 0 || p.entryFee < 0 ||
        !Number.isInteger(p.entryIndex) || p.entryIndex < session.start || p.entryIndex > session.cursor || p.entryIndex > session.end || !candleAt(data, p.entryIndex)) return false;
  }
  if (session.orderHistory !== undefined && (!Array.isArray(session.orderHistory) || !session.orderHistory.every(o => o &&
      ['filled', 'cancelled'].includes(o.status) && ['limit', 'market'].includes(o.type) && typeof o.id === 'string' && [o.side, o.notional, o.entryPrice].every(Number.isFinite) &&
      optionalSavedEntryReason(o.entryReason) &&
      [1, -1].includes(o.side) && o.notional > 0 && o.entryPrice > 0 && (o.status !== 'filled' ||
        [o.fillIndex, o.fillPrice].every(Number.isFinite) && o.fillIndex >= session.start && o.fillIndex <= session.cursor && o.fillPrice > 0) &&
      (o.status !== 'cancelled' || Number.isInteger(o.cancelledIndex) && o.cancelledIndex >= session.start && o.cancelledIndex <= session.cursor)))) return false;
  return session.trades.every(t => t && optionalSavedEntryReason(t.entryReason) && [t.pnl, t.fees, t.entry, t.exit, t.qty].every(Number.isFinite) &&
    t.entry > 0 && t.exit > 0 && t.qty > 0 && Number.isInteger(t.entryIndex) && Number.isInteger(t.exitIndex) &&
    t.entryIndex >= session.start && t.entryIndex <= t.exitIndex && t.exitIndex <= session.cursor &&
    !!candleAt(data, t.entryIndex) && !!candleAt(data, t.exitIndex));
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

export function openPosition(s, data, side, notional, stopPct, takePct, entryReason = '') {
  const normalizedReason = normalizeEntryReason(entryReason);
  if (!validIndexTriplet(s, data)) throw new Error('本轮行情范围无效');
  assertCandle(data, s.cursor);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (![1, -1].includes(side)) throw new Error('下单方向无效');
  if (!Number.isFinite(notional) || notional <= 0 || !optionalPercent(stopPct) || !optionalPercent(takePct))
    throw new Error('请输入有效金额和止盈止损距离（0到50%）；关闭保护请传null');
  if (!Number.isFinite(s.balance) || s.balance < 0 || notional * (1 + FEE) > s.balance) throw new Error('下单金额加手续费不能超过可用余额');
  const c = assertCandle(data, s.cursor);
  const entry = c[4] * (1 + side * SLIP);
  const entryFee = notional * FEE;
  s.position = {side, entry, qty: notional / entry, notional, entryFee, entryIndex: s.cursor,
    stop: stopPct === null ? null : entry * (1 - side * stopPct / 100),
    take: takePct === null ? null : entry * (1 + side * takePct / 100), stopPct, takePct, entryReason: normalizedReason};
  s.balance -= entryFee;
  return s.position;
}

function validateOrderPlan(s, side, notional, entryPrice, stopPrice, takePrice) {
  if (![1, -1].includes(side)) throw new Error('下单方向无效');
  if (![notional, entryPrice].every(Number.isFinite) || !optionalPrice(stopPrice) || !optionalPrice(takePrice) || notional <= 0 || entryPrice <= 0)
    throw new Error('请输入有效金额和价格');
  if (!protectionsBracket(side, entryPrice, stopPrice, takePrice)) throw new Error('已启用的止损和止盈必须位于计划入场价正确一侧');
  if (!Number.isFinite(s.balance) || s.balance < 0 || notional * (1 + FEE) > s.balance + 1e-8)
    throw new Error('下单金额加手续费不能超过可用余额');
}

function positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, index, orderId = null, entryReason = undefined) {
  const entryFee = notional * FEE;
  const position = {side, entry: fillPrice, qty: notional / fillPrice, notional, entryFee, entryIndex: index,
    stop: stopPrice, take: takePrice,
    stopPct: stopPrice === null ? null : Math.abs((fillPrice - stopPrice) / fillPrice * 100),
    takePct: takePrice === null ? null : Math.abs((takePrice - fillPrice) / fillPrice * 100), orderId};
  if (entryReason !== undefined) position.entryReason = entryReason;
  s.position = position;
  s.balance -= entryFee;
  return position;
}

function recordFilledOrder(s, order, fillIndex, fillPrice) {
  const record = {...order, status: 'filled', fillIndex, fillPrice};
  s.orderHistory ??= [];
  s.orderHistory.push(record);
  return record;
}

// Market orders fill at the already disclosed close. Limit orders stay pending
// until a future observed 15m candle touches their price.
export function placeOrder(s, data, side, notional, entryPrice, stopPrice, takePrice, orderType = 'market', entryReason = '') {
  const normalizedReason = normalizeEntryReason(entryReason);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (!['market', 'limit'].includes(orderType)) throw new Error('订单类型无效');
  const currentPrice = assertCandle(data, s.cursor)[4];
  const planPrice = orderType === 'market' ? currentPrice : entryPrice;
  validateOrderPlan(s, side, notional, planPrice, stopPrice, takePrice);
  const order = {id: crypto.randomUUID(), side, notional, entryPrice: planPrice, stop: stopPrice, take: takePrice,
    type: orderType, placedIndex: s.cursor, entryReason: normalizedReason};
  const marketableLimit = orderType === 'limit' && (side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice);
  if (orderType === 'market' || marketableLimit) {
    const slippedMarket = currentPrice * (1 + side * SLIP);
    const fillPrice = orderType === 'market' ? slippedMarket :
      side === 1 ? Math.min(entryPrice, slippedMarket) : Math.max(entryPrice, slippedMarket);
    // Immediate fills must leave both protections on the correct side of fill.
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    const position = positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, s.cursor, order.id, normalizedReason);
    const filled = recordFilledOrder(s, order, s.cursor, fillPrice);
    return {status: 'filled', order: filled, position};
  }
  const pending = {...order};
  s.pending = pending;
  s.orderHistory ??= [];
  return {status: 'pending', order: pending};
}

export function cancelOrder(s, reason = '用户撤单') {
  if (!s?.pending) return null;
  const cancelled = {...s.pending, status: 'cancelled', reason, cancelledIndex: s.cursor};
  s.orderHistory ??= [];
  s.orderHistory.push(cancelled);
  s.pending = null;
  return cancelled;
}

export function updatePendingOrder(s, data, entryPrice, stopPrice, takePrice) {
  if (!validateSession(s, s?.symbol, data) || !s.pending) throw new Error('当前没有有效挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  validateOrderPlan(s, s.pending.side, s.pending.notional, entryPrice, stopPrice, takePrice);
  const currentPrice = assertCandle(data, s.cursor)[4], side = s.pending.side;
  const updated = {...s.pending, entryPrice, stop: stopPrice, take: takePrice, modifiedIndex: s.cursor};
  const marketable = side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice;
  if (marketable) {
    const slippedMarket = currentPrice * (1 + side * SLIP);
    const fillPrice = side === 1 ? Math.min(entryPrice, slippedMarket) : Math.max(entryPrice, slippedMarket);
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    s.pending = null;
    const position = positionAtPrice(s, data, side, updated.notional, fillPrice, stopPrice, takePrice, s.cursor, updated.id, updated.entryReason);
    const filled = recordFilledOrder(s, updated, s.cursor, fillPrice);
    return {status: 'filled', order: filled, position};
  }
  s.pending = updated;
  return {status: 'pending', order: s.pending};
}

export function updateProtection(s, data, stopPrice, takePrice) {
  if (!validateSession(s, s?.symbol, data) || !s.position) throw new Error('当前没有有效持仓');
  if (!optionalPrice(stopPrice) || !optionalPrice(takePrice)) throw new Error('保护价格无效；关闭保护请传null');
  const price = assertCandle(data, s.cursor)[4], p = s.position;
  if (!protectionsBracket(p.side, price, stopPrice, takePrice)) throw new Error('止盈止损必须分列在当前价格两侧');
  p.stop = stopPrice; p.take = takePrice;
  p.stopPct = stopPrice === null ? null : Math.abs((p.entry - stopPrice) / p.entry * 100);
  p.takePct = takePrice === null ? null : Math.abs((takePrice - p.entry) / p.entry * 100);
  return p;
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
  const gapStop = p.stop !== null && (p.side === 1 ? c[1] <= p.stop : c[1] >= p.stop);
  const hitStop = p.stop !== null && (p.side === 1 ? c[3] <= p.stop : c[2] >= p.stop);
  if (gapStop) return closePosition(s, data, c[1], '跳空止损', index);
  const gapTake = p.take !== null && (p.side === 1 ? c[1] >= p.take : c[1] <= p.take);
  if (!entryBar && gapTake) return closePosition(s, data, c[1], '跳空止盈', index);
  if (hitStop) {
    const hitTake = p.take !== null && (p.side === 1 ? c[2] >= p.take : c[3] <= p.take);
    return closePosition(s, data, p.stop, hitTake ? '双触发，按止损' : entryBar ? '入场同根止损' : '止损', index);
  }
  if (entryBar) return null; // Intrabar order is unknown; defer take-profit to the next candle.
  const hitTake = p.take !== null && (p.side === 1 ? c[2] >= p.take : c[3] <= p.take);
  if (hitTake) return closePosition(s, data, p.take, '止盈', index);
  return null;
}

export function closePosition(s, data, price, reason = '手动平仓', index = s?.cursor) {
  if (!s?.position) return null;
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (price === undefined) price = assertCandle(data, index)[4];
  if (!Number.isFinite(price) || !Number.isInteger(index) || index < s.position.entryIndex || index > s.cursor || index >= data.length || price <= 0) throw new Error('平仓价格或行情索引无效');
  const c = assertCandle(data, index);
  const p = s.position;
  const exit = price * (1 - p.side * SLIP);
  const exitFee = exit * p.qty * FEE;
  const gross = (exit - p.entry) * p.qty * p.side;
  const trade = {...p, id: crypto.randomUUID(), exit, exitIndex: index, exitTime: c[0] + BASE,
    entryTime: assertCandle(data, p.entryIndex)[0] + BASE, pnl: gross - p.entryFee - exitFee, fees: p.entryFee + exitFee, reason};
  s.balance += gross - exitFee;
  s.trades.push(trade);
  s.position = null;
  return trade;
}

// Walk underlying 15m bars in order. At an exact stop/take touch, stop wins;
// gaps fill from the bar open. Playback pauses at the exit for review.
export function advance(s, data) {
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
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
        positionAtPrice(s, data, pending.side, pending.notional, fillPrice, pending.stop, pending.take, i, pending.id, pending.entryReason);
        orderFilled = recordFilledOrder(s, pending, i, fillPrice);
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
  const price = assertCandle(data, s.cursor)[4];
  const estimatedExit = price * (1 - (p?.side ?? 1) * SLIP);
  const unreal = p ? (estimatedExit - p.entry) * p.qty * p.side - estimatedExit * p.qty * FEE : 0;
  const equity = s.balance + unreal;
  const win = s.trades.filter(t => t.pnl > 0).length;
  const fees = s.trades.reduce((n, t) => n + t.fees, 0) + (p?.entryFee || 0) + (p ? estimatedExit * p.qty * FEE : 0);
  return {unreal, equity, pnl: equity - INITIAL, winRate: s.trades.length ? win / s.trades.length * 100 : null, fees};
}
