export const INITIAL = 10000;
export const FEE = 0.0004;
export const SLIP = 0.0002;
export const BASE = 900;
export const DEFAULT_LEVERAGE = 1;
export const MAX_LEVERAGE = 100;
export const MAINTENANCE_MARGIN_RATE = 0.005;
export const ISOLATED_MARGIN_MODE = 'isolated-v1';
export const ENGINE_VERSION = 'paper-engine-v2.0.0';
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

function optionalSavedExitReason(value) {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 2000);
}

function optionalAttemptNumber(value) {
  return value === undefined || value === null || (Number.isInteger(value) && value >= 1);
}

function initialRiskValid(record) {
  if (record.initialStop === undefined && record.initialRiskR0 === undefined) return true;
  if (!optionalPrice(record.initialStop) || !(record.initialRiskR0 === null || (Number.isFinite(record.initialRiskR0) && record.initialRiskR0 > 0))) return false;
  const stop = record.initialStop;
  if (stop === null) return record.initialRiskR0 === null;
  if (![1, -1].includes(record.side) || !Number.isFinite(record.entry) || !Number.isFinite(record.qty) || record.qty <= 0) return false;
  const correctlyBracketed = record.side === 1 ? stop < record.entry : stop > record.entry;
  if (!correctlyBracketed) return record.initialRiskR0 === null;
  return near(record.initialRiskR0, record.qty * Math.abs(record.entry - stop));
}

function normalizeExitReason(value) {
  if (typeof value !== 'string') throw new Error('平仓理由必须是非空文本，最多2000字');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) throw new Error('平仓理由必须是非空文本，最多2000字');
  return trimmed;
}

function normalizeMetadata(value = {}) {
  if (value === undefined || value === null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('交易证据metadata无效');
  const out = {};
  for (const key of ['planId', 'thesisId', 'parentTradeId', 'strategyVersion', 'observationId']) {
    const v = value[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.trim().length > 200)) throw new Error(`${key}必须是有效文本`);
    out[key] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  const lossBudget = value.lossBudget;
  if (lossBudget !== undefined && lossBudget !== null && (!Number.isFinite(lossBudget) || lossBudget < 0)) throw new Error('亏损预算必须为非负金额或null');
  out.lossBudget = lossBudget ?? null;
  const attemptNumber = value.attemptNumber;
  if (attemptNumber !== undefined && attemptNumber !== null && (!Number.isInteger(attemptNumber) || attemptNumber < 1)) throw new Error('attemptNumber必须是正整数或null');
  out.attemptNumber = attemptNumber ?? null;
  const reason = value.changeReason ?? value.reason;
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 2000)) throw new Error('风险修改理由必须是非空文本且不超过2000字');
  out.changeReason = typeof reason === 'string' ? reason.trim() : null;
  if (value.rawReason !== undefined && value.rawReason !== null && (typeof value.rawReason !== 'string' || value.rawReason.length > 2000)) throw new Error('原始理由无效');
  out.rawReason = typeof value.rawReason === 'string' ? value.rawReason : null;
  return out;
}

function simulationModel(modelConfigId, effectiveFrom, baselineOnly = false) {
  return {modelConfigId, engineVersion: ENGINE_VERSION, productType: 'spot-market-data',
    executionModel: 'local-isolated-paper-simulator',
    fee: {openRate: FEE, closeRate: FEE, basis: 'executedNotional', rounding: 'native-float-no-explicit-rounding'},
    slippage: {rate: SLIP, rule: 'adverse-proportional-on-entry-and-exit'},
    entry: {market: 'current-disclosed-close', limit: 'marketable-immediate-otherwise-touch'},
    stopTake: {touchResolution: '1m-OHLC', sameBarStopAndTake: 'stop-first', entryBarStop: 'checked-on-entry-minute', entryBarTake: 'defer-until-next-minute', gapExecution: 'observed-open-price'},
    intrabar: {resolution: '1m-OHLC', bothStopTake: 'stop-first', entryBarTake: 'defer-until-next-bar', gap: 'open-price'},
    margin: {mode: ISOLATED_MARGIN_MODE, maintenanceRate: MAINTENANCE_MARGIN_RATE,
      liquidation: 'estimated-trigger-price-includes-close-fee; execution-uses-disclosed-open-or-threshold'},
    isolatedLossCap: 'settlement-adjustment-limits-wallet-loss-to-position-margin',
    markToMarket: 'estimated-close-after-adverse-slip-and-close-fee',
    rounding: {money: 'none-explicit'}, funding: 'not-simulated', borrow: 'not-simulated',
    randomness: 'session-range-random-sampling-only-no-trading-randomness', effectiveFrom, baselineOnly};
}

function currentAccountValues(session, data) {
  const p = session.position;
  const mark = replayPrice(session, data) ?? session.accountSnapshots?.at(-1)?.currentPrice ?? null;
  const exit = p && Number.isFinite(mark) ? mark * (1 - p.side * SLIP) : mark;
  const unreal = p && Number.isFinite(exit) ? (exit - p.entry) * p.qty * p.side - exit * p.qty * FEE : 0;
  const usedMargin = p ? (p.marginMode === ISOLATED_MARGIN_MODE ? p.margin : p.notional) : 0;
  const reservedMargin = session.pending ? (session.pending.marginMode === ISOLATED_MARGIN_MODE
    ? session.pending.margin + session.pending.notional * FEE : session.pending.notional * (1 + FEE)) : 0;
  return {equity: session.balance + unreal, availableBalance: session.balance - usedMargin - reservedMargin,
    usedMargin, reservedMargin, price: mark};
}

function appendAccountSnapshot(session, data, type = 'account-state') {
  if (!Array.isArray(session.accountSnapshots)) session.accountSnapshots = [];
  const values = currentAccountValues(session, data), at = replayTime(session, data) ?? session.accountSnapshots?.at(-1)?.replayMarketTime ?? null;
  const snapshot = {id: crypto.randomUUID(), seq: session.accountSnapshots.length + 1, type,
    recordedAt: new Date().toISOString(), replayMarketTime: at, visibleThrough: at,
    engineVersion: session.activeEngineVersion ?? session.engineVersion ?? null,
    modelConfigId: session.modelConfigId ?? null,
    cursor: Array.isArray(data) ? visibleUpperIndex(session, data) : (session.forming15m ? session.cursor + 1 : session.cursor), minuteCursorTime: session.minuteCursorTime ?? null,
    currentPrice: values.price, balance: session.balance, equity: values.equity,
    availableBalance: values.availableBalance, usedMargin: values.usedMargin, reservedMargin: values.reservedMargin,
    positionId: session.position?.positionId ?? null, pendingOrderId: session.pending?.id ?? null,
    valuation: 'net-close-estimate'};
  session.accountSnapshots.push(snapshot);
  return snapshot;
}

function appendLedger(session, data, type, fields = {}) {
  if (!Array.isArray(session.ledger)) session.ledger = [];
  const values = currentAccountValues(session, data), at = replayTime(session, data) ?? session.accountSnapshots?.at(-1)?.replayMarketTime ?? null;
  const previous = session.ledger.at(-1);
  const item = {id: crypto.randomUUID(), seq: session.ledger.length + 1, type,
    recordedAt: new Date().toISOString(), replayMarketTime: at, visibleThrough: at,
    engineVersion: session.activeEngineVersion ?? session.engineVersion ?? null,
    cashDelta: 0, balanceAfter: session.balance, equityAfter: values.equity,
    usedMarginAfter: values.usedMargin, reservedMarginAfter: values.reservedMargin,
    marginDelta: 0, reservedMarginDelta: 0, grossPnl: 0, fee: 0, isolatedAdjustment: 0,
    ...(previous ? {} : {baselineBalance: session.balance - (Number.isFinite(fields.cashDelta) ? fields.cashDelta : 0)}), modelConfigId: session.modelConfigId ?? null,
    ...fields};
  session.ledger.push(item);
  return item;
}

function recordRiskChange(session, data, objectType, object, before, after, metadata = {}) {
  if (!Array.isArray(session.riskChanges)) session.riskChanges = [];
  const at = replayTime(session, data);
  const change = {id: crypto.randomUUID(), seq: session.riskChanges.length + 1,
    recordedAt: new Date().toISOString(), replayMarketTime: at, visibleThrough: at,
    objectType, orderId: object?.id ?? object?.orderId ?? null, positionId: object?.positionId ?? null,
    planId: object?.planId ?? null, before, after, initialRiskR0: object?.initialRiskR0 ?? null,
    reason: metadata.changeReason ?? null, rawReason: metadata.rawReason ?? null,
    thesisId: object?.thesisId ?? null, attemptNumber: metadata.attemptNumber ?? object?.attemptNumber ?? null,
    modelConfigId: session.modelConfigId ?? null};
  session.riskChanges.push(change);
  appendLedger(session, data, 'risk-change', {orderId: change.orderId, positionId: change.positionId});
  appendAccountSnapshot(session, data, 'risk-change');
  return change;
}

function initialRiskFields(side, entry, qty, stop) {
  const r0 = optionalPrice(stop) && stop !== null && Number.isFinite(qty) && qty > 0 &&
    (side === 1 ? stop < entry : stop > entry) ? qty * Math.abs(entry - stop) : null;
  return {initialStop: stop ?? null, initialTake: null, initialRiskR0: r0};
}

function activeModelConfig(session) {
  return (session?.modelConfigs ?? []).find(config => config?.modelConfigId === session?.modelConfigId) ?? null;
}

function riskRates(modelConfig) {
  const feeOpenRate = modelConfig?.fee?.openRate ?? FEE;
  const feeCloseRate = modelConfig?.fee?.closeRate ?? FEE;
  const slippageRate = modelConfig?.slippage?.rate ?? SLIP;
  if (![feeOpenRate, feeCloseRate, slippageRate].every(value => Number.isFinite(value) && value >= 0))
    throw new Error('冻结交易成本模型无效');
  return {feeOpenRate, feeCloseRate, slippageRate};
}

function limitFillAtCurrentPrice(side, currentPrice, limitPrice, slippageRate) {
  const slipped = currentPrice * (1 + side * slippageRate);
  return side === 1 ? Math.min(limitPrice, slipped) : Math.max(limitPrice, slipped);
}

function riskAtEntry({side, notional, entry, stop, take, basis, modelConfig = null, referencePrice = entry}) {
  const {feeOpenRate, feeCloseRate, slippageRate} = riskRates(modelConfig);
  const qty = notional / entry;
  const entryFee = notional * feeOpenRate;
  const stopExitPrice = stop === null ? null : stop * (1 - side * slippageRate);
  const grossStopLoss = stop === null ? null : Math.max(0, (entry - stopExitPrice) * qty * side);
  const netStopRisk = stop === null ? null : grossStopLoss + entryFee + stopExitPrice * qty * feeCloseRate;
  const takeExitPrice = take === null ? null : take * (1 - side * slippageRate);
  const expectedTakeProfitNet = take === null ? null
    : (takeExitPrice - entry) * qty * side - entryFee - takeExitPrice * qty * feeCloseRate;
  const priceRisk = stop === null ? null : qty * Math.abs(entry - stop);
  const netRewardRisk = netStopRisk > 0 && expectedTakeProfitNet !== null ? expectedTakeProfitNet / netStopRisk : null;
  return {riskCalculationVersion: 'net-stop-risk-v1', basis, referencePrice, estimatedEntryPrice: entry,
    estimatedQty: qty, priceRisk, priceRiskUnavailableReason: stop === null ? '未设置止损，价格差风险不可计算。' : null,
    netStopRisk, netStopRiskUnavailableReason: stop === null ? '未设置止损，预计净止损风险不可计算。' : null,
    // Compatibility alias: this has always been the plan's monetary stop-risk field.
    plannedRiskIncludingCosts: netStopRisk,
    expectedTakeProfitNet, expectedTakeProfitNetUnavailableReason: take === null ? '未设置止盈，预计净止盈收益不可计算。' : null,
    netRewardRisk, netRewardRiskUnavailableReason: stop === null ? '未设置止损，净盈亏比不可计算。'
      : take === null ? '未设置止盈，净盈亏比不可计算。' : netStopRisk <= 0 ? '预计净止损风险不是正数，净盈亏比不可计算。' : null,
    costModel: {feeOpenRate, feeCloseRate, slippageRate, feeBasis: 'executed-notional', slippageRule: 'adverse-proportional',
      modelConfigId: modelConfig?.modelConfigId ?? null, engineVersion: modelConfig?.engineVersion ?? ENGINE_VERSION,
      executionConfigMatchesRuntime: feeOpenRate === FEE && feeCloseRate === FEE && slippageRate === SLIP}};
}

/** Estimate a stop/target envelope using the same entry, exit, fee, and slippage rules as fills. */
export function estimateOrderRisk({side, notional, currentPrice, entryPrice = currentPrice, stop = null, take = null,
  orderType = 'market', modelConfig = null} = {}) {
  if (![1, -1].includes(side) || !Number.isFinite(notional) || notional <= 0 ||
      !Number.isFinite(currentPrice) || currentPrice <= 0 || !optionalPrice(stop) || !optionalPrice(take) ||
      !['market', 'limit'].includes(orderType) || (orderType === 'limit' && (!Number.isFinite(entryPrice) || entryPrice <= 0)))
    throw new Error('风险估算输入无效');
  const {slippageRate} = riskRates(modelConfig);
  let estimatedEntryPrice, basis;
  if (orderType === 'market') {
    estimatedEntryPrice = currentPrice * (1 + side * slippageRate);
    basis = 'market-expected-adverse-fill';
  } else {
    const marketable = side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice;
    estimatedEntryPrice = marketable
      ? limitFillAtCurrentPrice(side, currentPrice, entryPrice, slippageRate) : entryPrice;
    basis = marketable ? 'marketable-limit-capped-fill' : 'limit-price-scenario';
  }
  return riskAtEntry({side, notional, entry: estimatedEntryPrice, stop, take, basis, modelConfig, referencePrice: orderType === 'market' ? currentPrice : entryPrice});
}

function addEntryFill(session, {orderId, position, price, index, time, executionType}) {
  if (!Array.isArray(session.fills)) session.fills = [];
  const fill = {id: crypto.randomUUID(), seq: session.fills.length + 1, orderId: orderId ?? null, positionId: position.positionId, tradeId: null,
    planId: position.planId ?? null, thesisId: position.thesisId ?? null, parentTradeId: position.parentTradeId ?? null,
    strategyVersion: position.strategyVersion ?? null, observationId: position.observationId ?? null,
    attemptNumber: position.attemptNumber ?? null, initialStop: position.initialStop ?? null,
    initialTake: position.initialTake ?? null, initialRiskR0: position.initialRiskR0 ?? null,
    side: 'entry', positionSide: position.side, price, qty: position.qty, notional: position.notional, fee: position.entryFee,
    index, time, replayMarketTime: time, visibleThrough: time, recordedAt: new Date().toISOString(), executionType,
    modelConfigId: session.modelConfigId ?? null, engineVersion: session.activeEngineVersion ?? session.engineVersion ?? null};
  session.fills.push(fill);
  position.entryFillId = fill.id;
  return fill;
}

function addExitFill(session, trade, price, index, time, executionType) {
  if (!Array.isArray(session.fills)) session.fills = [];
  const exitFee = price * trade.qty * FEE;
  const fill = {id: crypto.randomUUID(), seq: session.fills.length + 1, orderId: trade.orderId ?? null, positionId: trade.positionId ?? null,
    tradeId: trade.id, side: 'exit', positionSide: trade.side, price, qty: trade.qty, notional: price * trade.qty, fee: exitFee,
    index, time, replayMarketTime: time, visibleThrough: time, recordedAt: new Date().toISOString(), executionType,
    modelConfigId: session.modelConfigId ?? null, engineVersion: session.activeEngineVersion ?? session.engineVersion ?? null};
  session.fills.push(fill);
  trade.exitFillId = fill.id;
  return fill;
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
      !optionalSavedEntryReason(pending.entryReason) || !optionalAttemptNumber(pending.attemptNumber) || !marginRecordValid(pending, pending.entryPrice) ||
      (pending.marginMode === ISOLATED_MARGIN_MODE
        ? pending.margin + pending.notional * FEE > session.balance + 1e-8
        : pending.notional * (1 + FEE) > session.balance + 1e-8) ||
      !protectionsBracket(pending.side, pending.entryPrice, pending.stop, pending.take))) return false;
  if (session.position !== null && session.position !== undefined) {
    const p = session.position;
    if (!p || ![1, -1].includes(p.side) || ![p.entry, p.qty, p.notional, p.entryFee].every(Number.isFinite) ||
        !optionalPrice(p.stop) || !optionalPrice(p.take) || !storedPercent(p.stopPct) || !storedPercent(p.takePct) ||
        !optionalSavedEntryReason(p.entryReason) || !optionalAttemptNumber(p.attemptNumber) || !initialRiskValid(p) || p.entry <= 0 || p.qty <= 0 || p.notional <= 0 || p.entryFee < 0 ||
        !Number.isInteger(p.entryIndex) || p.entryIndex < session.start || p.entryIndex > visibleIndex || p.entryIndex > session.end || !candleAt(data, p.entryIndex) ||
        (p.entryTime !== undefined && (!timeMatchesIndex(p.entryTime, p.entryIndex, data) || p.entryTime > replayTime(session, data))) ||
        !marginRecordValid(p, p.entry) || (p.marginMode === ISOLATED_MARGIN_MODE && p.margin > session.balance + 1e-8)) return false;
    if (p.entryFillId !== undefined && (!Array.isArray(session.fills) || !session.fills.some(f => f.id === p.entryFillId &&
      f.side === 'entry' && f.positionId === p.positionId && f.orderId === (p.orderId ?? null)))) return false;
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
  const validTrades = session.trades.every(t => t && optionalSavedEntryReason(t.entryReason) && optionalSavedExitReason(t.exitReason) &&
    optionalAttemptNumber(t.attemptNumber) && initialRiskValid(t) && [t.pnl, t.fees, t.entry, t.exit, t.qty].every(Number.isFinite) &&
    (t.triggerEvidence === undefined || (t.triggerEvidence && ['stop', 'take', 'liquidation'].includes(t.triggerEvidence.type) &&
      Number.isFinite(t.triggerEvidence.triggerPrice) && t.triggerEvidence.triggerPrice > 0 &&
      Number.isInteger(t.triggerEvidence.referenceMinute) && t.triggerEvidence.referenceMinute % 60 === 0 &&
      Number.isInteger(t.triggerEvidence.referenceIntervalSeconds) && t.triggerEvidence.referenceIntervalSeconds >= 60 &&
      t.triggerEvidence.triggerMarketTime === t.triggerEvidence.referenceMinute + t.triggerEvidence.referenceIntervalSeconds &&
      t.triggerEvidence.triggerMarketTime <= replayTime(session, data) && typeof t.triggerEvidence.ruleId === 'string' &&
      t.triggerEvidence.ruleId.length > 0 && t.triggerEvidence.actualIntrabarOrderUnknown === true &&
      (t.triggerEvidence.affectedOrderIds === undefined || Array.isArray(t.triggerEvidence.affectedOrderIds) &&
        t.triggerEvidence.affectedOrderIds.every(id => typeof id === 'string')))) &&
    (t.entryTime === undefined || timeMatchesIndex(t.entryTime, t.entryIndex, data) && t.entryTime <= replayTime(session, data)) &&
    (t.exitTime === undefined || timeMatchesIndex(t.exitTime, t.exitIndex, data) && t.exitTime <= replayTime(session, data)) &&
    t.entry > 0 && t.exit > 0 && t.qty > 0 && Number.isInteger(t.entryIndex) && Number.isInteger(t.exitIndex) &&
    t.entryIndex >= session.start && t.entryIndex <= t.exitIndex && t.exitIndex <= visibleIndex &&
    !!candleAt(data, t.entryIndex) && !!candleAt(data, t.exitIndex) && marginRecordValid(t, t.entry, {trade: true}));
  if (!validTrades) return false;
  if (session.engineVersion !== undefined) {
    if (typeof session.engineVersion !== 'string' || !Array.isArray(session.modelConfigs) || !session.modelConfigs.length ||
        !session.modelConfigs.some(m => m?.modelConfigId === session.modelConfigId) || !Array.isArray(session.orders) ||
        !Array.isArray(session.fills) || !Array.isArray(session.ledger) || !Array.isArray(session.riskChanges) || !Array.isArray(session.accountSnapshots)) return false;
    if (session.activeEngineVersion !== undefined && typeof session.activeEngineVersion !== 'string') return false;
    if (new Set(session.modelConfigs.map(m => m?.modelConfigId)).size !== session.modelConfigs.length ||
        !session.modelConfigs.every(m => typeof m?.modelConfigId === 'string' && typeof m.engineVersion === 'string' &&
          typeof m.baselineOnly === 'boolean' && m.effectiveFrom && Number.isFinite(m.effectiveFrom.replayMarketTime))) return false;
    const unique = xs => new Set(xs.map(x => x?.id)).size === xs.length && xs.every(x => typeof x?.id === 'string' && x.id.length > 0);
    if (![session.orders, session.fills, session.ledger, session.riskChanges, session.accountSnapshots].every(unique)) return false;
    if (!session.ledger.every((row, i) => Number.isInteger(row.seq) && row.seq === i + 1 && Number.isFinite(row.cashDelta) &&
      Number.isFinite(row.balanceAfter) && Number.isFinite(row.equityAfter) && typeof row.type === 'string' &&
      (i === 0 ? Number.isFinite(row.baselineBalance) && near(row.baselineBalance + row.cashDelta, row.balanceAfter)
        : near(row.balanceAfter, session.ledger[i - 1].balanceAfter + row.cashDelta)))) return false;
    if (session.ledger.length && !near(session.ledger.at(-1).balanceAfter, session.balance)) return false;
    const modelIds = new Set(session.modelConfigs.map(m => m.modelConfigId));
    if (!session.fills.every((f, i) => f.seq === i + 1 && ['entry', 'exit'].includes(f.side) && [f.price, f.qty, f.notional, f.fee].every(Number.isFinite) &&
      f.price > 0 && f.qty > 0 && f.notional > 0 && f.fee >= 0 && typeof f.positionId === 'string' &&
      Number.isInteger(f.index) && f.index >= session.start && f.index <= visibleIndex &&
      (f.time === undefined || (timeMatchesIndex(f.time, f.index, data) && f.time <= replayTime(session, data))) &&
      (f.visibleThrough === undefined || Number.isFinite(f.visibleThrough) && f.visibleThrough <= replayTime(session, data)) &&
      (f.modelConfigId == null || modelIds.has(f.modelConfigId)) && optionalAttemptNumber(f.attemptNumber) &&
      (f.side !== 'entry' || (initialRiskValid({...f, side: f.positionSide, entry: f.price}) && f.tradeId === null)) &&
      (f.side !== 'exit' || typeof f.tradeId === 'string'))) return false;
    if (!session.orders.every(o => typeof o.id === 'string' && (o.modelConfigId == null || modelIds.has(o.modelConfigId)) && optionalAttemptNumber(o.attemptNumber) &&
      (!Number.isFinite(o.placedTime) || Number.isInteger(o.placedIndex) && timeMatchesIndex(o.placedTime, o.placedIndex, data) && o.placedTime <= replayTime(session, data)))) return false;
    if (!session.accountSnapshots.every(snapshot => Number.isInteger(snapshot.seq) && typeof snapshot.type === 'string' &&
      Number.isFinite(snapshot.balance) && Number.isFinite(snapshot.equity) && Number.isFinite(snapshot.availableBalance) &&
      Number.isFinite(snapshot.usedMargin) && Number.isFinite(snapshot.reservedMargin) &&
      (snapshot.modelConfigId == null || modelIds.has(snapshot.modelConfigId)) &&
      (snapshot.replayMarketTime === null || Number.isFinite(snapshot.replayMarketTime) && snapshot.replayMarketTime <= replayTime(session, data)) &&
      (snapshot.visibleThrough === null || Number.isFinite(snapshot.visibleThrough) && snapshot.visibleThrough <= replayTime(session, data)))) return false;
    if (!session.riskChanges.every((r, i) => r.seq === i + 1 && typeof r.id === 'string' && r.before && r.after &&
      (r.initialRiskR0 === null || (Number.isFinite(r.initialRiskR0) && r.initialRiskR0 > 0)) &&
      (r.modelConfigId == null || modelIds.has(r.modelConfigId)) &&
      (r.replayMarketTime === null || Number.isFinite(r.replayMarketTime) && r.replayMarketTime <= replayTime(session, data)) &&
      (r.visibleThrough === null || Number.isFinite(r.visibleThrough) && r.visibleThrough <= replayTime(session, data)))) return false;
    const fillsById = new Map(session.fills.map(f => [f.id, f]));
    const tradesById = new Map(session.trades.map(t => [t.tradeId ?? t.id, t]));
    for (const f of session.fills) {
      const order = f.orderId == null ? null : session.orders.find(o => o.id === f.orderId);
      const oldOrderHistory = f.orderId == null ? null : session.orderHistory?.find(o => o.id === f.orderId);
      if (f.orderId != null && !order && !oldOrderHistory) return false;
      if (f.modelConfigId != null && order?.modelConfigId != null && order.modelConfigId !== f.modelConfigId) return false;
      if (f.modelConfigId != null && (!modelIds.has(f.modelConfigId) || f.replayMarketTime > replayTime(session, data) ||
          f.visibleThrough > replayTime(session, data))) return false;
      if (f.side === 'exit') {
        const trade = tradesById.get(f.tradeId);
        if (!trade || trade.exitFillId !== f.id || trade.positionId !== f.positionId) return false;
      }
    }
    for (const trade of session.trades) {
      if (trade.modelConfigId != null && !modelIds.has(trade.modelConfigId)) return false;
      if (trade.entryFillId !== undefined) {
        const entryFill = fillsById.get(trade.entryFillId);
        if (!entryFill || entryFill.side !== 'entry' || entryFill.positionId !== trade.positionId || entryFill.orderId !== (trade.orderId ?? null)) return false;
      }
      if (trade.exitFillId !== undefined) {
        const exitFill = fillsById.get(trade.exitFillId);
        if (!exitFill || exitFill.side !== 'exit' || exitFill.tradeId !== (trade.tradeId ?? trade.id)) return false;
      }
    }
    for (const row of session.ledger) {
      if (row.type === 'entry-fee') {
        const fill = fillsById.get(row.fillId);
        if (!fill || fill.side !== 'entry' || !near(row.cashDelta, -fill.fee) || !near(row.fee, fill.fee)) return false;
      } else if (row.type === 'exit-settlement') {
        const fill = fillsById.get(row.fillId), trade = tradesById.get(row.tradeId);
        if (!fill || fill.side !== 'exit' || !trade || fill.tradeId !== (trade.tradeId ?? trade.id) ||
            !near(row.cashDelta, trade.pnl + trade.entryFee) || !near(row.grossPnl, trade.grossPnl) ||
            !near(row.fee, fill.fee) || !near(row.isolatedAdjustment, trade.isolatedAdjustment ?? 0)) return false;
      } else if (row.type === 'margin-reserved' || row.type === 'margin-released') {
        const fill = fillsById.get(row.fillId);
        const record = session.position?.positionId === fill?.positionId ? session.position : session.trades.find(t => t.positionId === fill?.positionId);
        const expectedDelta = (row.type === 'margin-reserved' ? 1 : -1) * record?.margin;
        if (!fill || !record || fill.side !== (row.type === 'margin-reserved' ? 'entry' : 'exit') ||
            !near(row.cashDelta, 0) || !near(row.marginDelta, expectedDelta)) return false;
      } else if (row.type === 'order-margin-reserved' || row.type === 'order-reservation-released') {
        const order = session.orders.find(o => o.id === row.orderId);
        const expectedReserved = order?.marginMode === ISOLATED_MARGIN_MODE ? order.margin + order.notional * FEE : order?.notional * (1 + FEE);
        if (!order || !near(row.cashDelta, 0) || !near(row.reservedMarginDelta,
          (row.type === 'order-margin-reserved' ? 1 : -1) * expectedReserved)) return false;
      }
    }
  }
  return true;
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
  const created = new Date().toISOString(), modelConfigId = crypto.randomUUID();
  const session = {version: 1, id: crypto.randomUUID(), symbol, start, cursor: start, end: sessionEnd,
    balance: INITIAL, initialBalance: INITIAL, position: null, pending: null, orderHistory: [], orders: [], fills: [], trades: [],
    ledger: [], accountSnapshots: [], riskChanges: [], modelConfigId, engineVersion: ENGINE_VERSION, activeEngineVersion: ENGINE_VERSION,
    modelConfigs: [simulationModel(modelConfigId, {recordedAt: created, replayMarketTime: data[start][0] + BASE}, false)],
    tf: 14400, blind: true, ma: false, notes: '', created};
  appendLedger(session, data, 'initial-balance', {cashDelta: 0, balanceAfter: INITIAL, baselineBalance: INITIAL});
  appendAccountSnapshot(session, data, 'session-baseline');
  if (!validateSession(session, symbol, data)) throw new Error('行情数据范围无效');
  return session;
}

/** Establish a known-at-upgrade baseline for an older snapshot without inventing its historical model or trades. */
export function ensureEvidenceBaseline(session, data) {
  if (!session || typeof session !== 'object' || !Array.isArray(data) || !validateSession(session, session.symbol, data)) throw new Error('旧会话基线无效');
  const existingConfig = session.modelConfigs?.find(m => m?.modelConfigId === session.modelConfigId);
  if (session.evidenceBaselineId || existingConfig) {
    let changed = false;
    if (!session.activeEngineVersion) { session.activeEngineVersion = ENGINE_VERSION; changed = true; }
    if (session.evidenceBaselineId && existingConfig?.engineVersion === ENGINE_VERSION && existingConfig.baselineOnly) {
      existingConfig.baselineOnly = false;
      changed = true;
    }
    return changed;
  }
  const recordedAt = new Date().toISOString(), modelConfigId = crypto.randomUUID(), marketTime = replayTime(session, data);
  session.modelConfigs ??= [];
  session.modelConfigs.push(simulationModel(modelConfigId, {recordedAt, replayMarketTime: marketTime}, false));
  session.modelConfigId = modelConfigId;
  session.engineVersion ??= 'legacy-unversioned';
  session.activeEngineVersion = ENGINE_VERSION;
  session.modelEvidenceStart = {recordedAt, replayMarketTime: marketTime, visibleThrough: marketTime, reason: '旧存档升级时建立的已知基线；此前模型与操作历史未知'};
  session.evidenceBaselineId = crypto.randomUUID();
  session.ledger ??= [];
  session.orders ??= [];
  session.fills ??= [];
  session.riskChanges ??= [];
  session.accountSnapshots ??= [];
  const row = {id: crypto.randomUUID(), seq: session.ledger.length + 1, type: 'legacy-baseline',
    recordedAt, replayMarketTime: marketTime, visibleThrough: marketTime, cashDelta: 0,
    baselineBalance: session.balance, balanceAfter: session.balance,
    equityAfter: currentAccountValues(session, data).equity, usedMarginAfter: currentAccountValues(session, data).usedMargin,
    reservedMarginAfter: currentAccountValues(session, data).reservedMargin, marginDelta: 0, reservedMarginDelta: 0,
    grossPnl: 0, fee: 0, isolatedAdjustment: 0, modelConfigId: null, legacyHistoryUnknown: true};
  session.ledger.push(row);
  appendAccountSnapshot(session, data, 'legacy-upgrade-baseline');
  if (!validateSession(session, session.symbol, data)) throw new Error('旧会话基线校验失败');
  return true;
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
  const executionEvents = [];
  const stageClock = {cursor: next.cursor, minuteCursorTime: time, forming15m: next.forming15m ? [...next.forming15m] : null,
    currentPrice: next.currentPrice, replayMarketTime: eventTime, visibleThrough: eventTime};
  if (next.pending) {
    const pending = next.pending;
    const fillPrice = pendingFillPrice(pending, minuteCandle);
    if (fillPrice !== null) {
      const before = {position: null, pending: structuredClone(pending), balance: next.balance};
      const released = pending.marginMode === ISOLATED_MARGIN_MODE ? pending.margin + pending.notional * FEE : pending.notional * (1 + FEE);
      next.pending = null;
      if (next.modelConfigId) appendLedger(next, data, 'order-reservation-released', {reservedMarginDelta: -released, orderId: pending.id});
      positionAtPrice(next, data, pending.side, pending.notional, fillPrice, pending.stop, pending.take, eventIndex,
        pending.id, pending.entryReason, eventTime, pending.leverage ?? DEFAULT_LEVERAGE, pending.marginMode, pending, 'limit-touch-1m');
      orderFilled = recordFilledOrder(next, pending, eventIndex, fillPrice, eventTime, next.position);
      entryBar = true;
      executionEvents.push({seq: executionEvents.length + 1, kind: 'order-filled', recordedAt: new Date().toISOString(),
        marketTime: eventTime, replayMarketTime: eventTime, visibleThrough: eventTime,
        replayState: {...stageClock},
        orderId: pending.id, fillId: orderFilled.fillId ?? next.position.entryFillId, positionId: next.position.positionId,
        before: {...before, ...stageClock}, after: {position: structuredClone(next.position), pending: null, balance: next.balance, ...stageClock},
        account: {before: {balance: before.balance, ...currentAccountValues({...next, pending: before.pending, position: before.position}, data)},
          after: {balance: next.balance, ...currentAccountValues(next, data)}},
        intrabarActualUnknown: true, rule: {id: 'limit-touch-on-observed-1m', version: next.activeEngineVersion ?? next.engineVersion ?? 'legacy-engine-unversioned'}});
    }
  }
  const positionBeforeExit = next.position ? structuredClone(next.position) : null;
  const balanceBeforeExit = next.balance;
  if (next.position) trade = exitPositionOnBar(next, data, minuteCandle, eventIndex, entryBar, 60);
  if (trade?.triggerEvidence) executionEvents.push({seq: executionEvents.length + 1, kind: 'position-triggered', recordedAt: new Date().toISOString(),
    marketTime: eventTime, replayMarketTime: eventTime, visibleThrough: eventTime,
    replayState: {...stageClock},
    orderId: trade.orderId ?? null, tradeId: trade.tradeId ?? trade.id, positionId: trade.positionId ?? null,
    before: {position: positionBeforeExit, pending: structuredClone(next.pending), balance: balanceBeforeExit, ...stageClock},
    after: {position: structuredClone(positionBeforeExit), pending: structuredClone(next.pending), balance: balanceBeforeExit,
      triggerEvidence: structuredClone(trade.triggerEvidence), ...stageClock},
    account: {before: {balance: balanceBeforeExit, ...currentAccountValues({...next, position: positionBeforeExit}, data)},
      after: {balance: balanceBeforeExit, ...currentAccountValues({...next, position: positionBeforeExit}, data)}},
    reason: trade.reason, affectedOrderIds: trade.triggerEvidence.affectedOrderIds ?? [],
    intrabarAmbiguous: trade.executionEvidence?.intrabarAmbiguous ?? false,
    triggerEvidence: structuredClone(trade.triggerEvidence), rule: trade.executionEvidence ?? trade.triggerEvidence,
    intrabarActualUnknown: trade.triggerEvidence.actualIntrabarOrderUnknown});
  if (trade) executionEvents.push({seq: executionEvents.length + 1, kind: 'position-auto-closed', recordedAt: new Date().toISOString(),
    marketTime: eventTime, replayMarketTime: eventTime, visibleThrough: eventTime,
    replayState: {...stageClock},
    orderId: trade.orderId ?? null, tradeId: trade.tradeId ?? trade.id, positionId: trade.positionId ?? null, fillId: trade.exitFillId ?? null,
    before: {position: positionBeforeExit, pending: structuredClone(next.pending), balance: balanceBeforeExit, ...stageClock},
    after: {position: null, trade: structuredClone(trade), pending: structuredClone(next.pending), balance: next.balance, ...stageClock},
    account: {before: {balance: balanceBeforeExit, ...currentAccountValues({...next, position: positionBeforeExit}, data)},
      after: {balance: next.balance, ...currentAccountValues(next, data)}},
    reason: trade.reason, triggerEvidence: trade.triggerEvidence ? structuredClone(trade.triggerEvidence) : null,
    affectedOrderIds: trade.executionEvidence?.affectedOrderIds ?? trade.triggerEvidence?.affectedOrderIds ?? [],
    intrabarAmbiguous: trade.executionEvidence?.intrabarAmbiguous ?? false, rule: trade.executionEvidence ?? null,
    intrabarActualUnknown: true});

  if (next.cursor >= next.end && !next.forming15m) {
    if (next.position) {
      const before = structuredClone(next.position), balanceBefore = next.balance;
      trade = closePosition(next, data, next.currentPrice, '本轮结束', next.cursor);
      executionEvents.push({seq: executionEvents.length + 1, kind: 'position-auto-closed', recordedAt: new Date().toISOString(),
        marketTime: eventTime, replayMarketTime: eventTime, visibleThrough: eventTime,
        replayState: {...stageClock},
        orderId: trade.orderId ?? null, tradeId: trade.tradeId ?? trade.id, positionId: trade.positionId ?? null, fillId: trade.exitFillId ?? null,
        before: {position: before, pending: structuredClone(next.pending), balance: balanceBefore, ...stageClock}, after: {position: null, trade: structuredClone(trade), pending: structuredClone(next.pending), balance: next.balance, ...stageClock},
        account: {before: {balance: balanceBefore, ...currentAccountValues({...next, position: before}, data)},
          after: {balance: next.balance, ...currentAccountValues(next, data)}},
        reason: trade.reason, affectedOrderIds: [], intrabarAmbiguous: false, rule: {id: 'session-end-close', version: next.activeEngineVersion ?? next.engineVersion ?? 'legacy-engine-unversioned'}, intrabarActualUnknown: true});
    }
    if (next.pending) orderCancelled = cancelOrder(next, '本轮结束未成交', data);
  }
  if (!validateSession(next, next.symbol, data)) throw new Error('分钟推进后状态校验失败');
  Object.assign(session, next);
  const currentTimeframeBoundary = intervalStart(previousCloseTime, session.tf) !== intervalStart(eventTime, session.tf);
  const values = currentAccountValues(session, data);
  const minuteAccountSnapshot = {type: 'minute-mark', recordedAt: new Date().toISOString(), replayMarketTime: eventTime,
    visibleThrough: eventTime, cursor: visibleUpperIndex(session, data), minuteCursorTime: time, currentPrice: minuteBar[4],
    balance: session.balance, equity: values.equity, availableBalance: values.availableBalance,
    usedMargin: values.usedMargin, reservedMargin: values.reservedMargin, valuation: 'net-close-estimate'};
  return {ended: replayEnded(session, data), minuteTime: time, replayTime: eventTime, currentPrice: minuteBar[4],
    forming15m: session.forming15m, completed15m, currentTimeframeBoundary, advanced15m: session.cursor - beforeIndex,
    trade, orderFilled, orderCancelled, executionEvents, minuteAccountSnapshot,
    intrabarAmbiguous: Boolean(trade?.executionEvidence?.intrabarAmbiguous),
    affectedOrderIds: trade?.executionEvidence?.affectedOrderIds ?? [], rule: trade?.executionEvidence ?? null};
}

export function openPosition(s, data, side, notional, stopPct, takePct, entryReason = '', leverage = DEFAULT_LEVERAGE, metadata = {}) {
  const normalizedReason = normalizeEntryReason(entryReason), meta = normalizeMetadata(metadata);
  if (!validIndexTriplet(s, data)) throw new Error('本轮行情范围无效');
  assertCandle(data, s.cursor);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (![1, -1].includes(side)) throw new Error('下单方向无效');
  if (!Number.isFinite(notional) || notional <= 0 || !optionalPercent(stopPct) || !optionalPercent(takePct) || !validLeverage(leverage))
    throw new Error('请输入有效金额和止盈止损距离（0到50%）；关闭保护请传null');
  if (!Number.isFinite(s.balance) || s.balance < 0 || marginFor(notional, leverage) + notional * FEE > s.balance + 1e-8) throw new Error('保证金加开仓手续费不能超过可用余额');
  const currentPrice = replayPrice(s, data), entry = currentPrice * (1 + side * SLIP);
  const stop = stopPct === null ? null : entry * (1 - side * stopPct / 100);
  const take = takePct === null ? null : entry * (1 + side * takePct / 100);
  const index = visibleUpperIndex(s, data), time = replayTime(s, data);
  if (!s.modelConfigId) {
    const entryFee = notional * FEE;
    s.position = {side, entry, qty: notional / entry, notional, entryFee, entryIndex: index, ...withMargin(notional, leverage, entry, side),
      stop, take, stopPct, takePct, entryReason: normalizedReason, entryTime: time};
    s.balance -= entryFee;
    return s.position;
  }
  const orderId = crypto.randomUUID();
  const orderRisk = estimateOrderRisk({side, notional, currentPrice, stop, take, orderType: 'market', modelConfig: activeModelConfig(s)});
  const order = {id: orderId, modelConfigId: s.modelConfigId ?? null, engineVersion: s.activeEngineVersion ?? s.engineVersion ?? null,
    type: 'market', side, notional, entryPrice: currentPrice, stop, take,
    placedIndex: index, placedTime: time, entryReason: normalizedReason, ...meta,
    riskBudget: {lossBudget: meta.lossBudget, basis: 'user-entered-currency-amount', status: meta.lossBudget == null ? 'not-provided' : 'provided'},
    pretradeRisk: {...orderRisk, reference: 'market-close-estimate', stop, margin: marginFor(notional, leverage), leverage},
    ...withMargin(notional, leverage, currentPrice, side)};
  s.orders ??= []; s.orders.push(order);
  const position = positionAtPrice(s, data, side, notional, entry, stop, take, index, orderId, normalizedReason, time, leverage, ISOLATED_MARGIN_MODE, meta, 'market-close');
  const filled = recordFilledOrder(s, order, index, entry, time, position);
  return position;
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

function positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, index, orderId = null, entryReason = undefined, entryTime = undefined, leverage = DEFAULT_LEVERAGE, marginMode = null, metadata = {}, executionType = 'market-close') {
  metadata = normalizeMetadata(metadata);
  const entryFee = notional * FEE, qty = notional / fillPrice;
  const positionId = crypto.randomUUID();
  const position = {positionId, side, entry: fillPrice, qty, notional, entryFee, entryIndex: index,
    ...(marginMode === ISOLATED_MARGIN_MODE ? withMargin(notional, leverage, fillPrice, side) : {}),
    stop: stopPrice, take: takePrice,
    stopPct: stopPrice === null ? null : Math.abs((fillPrice - stopPrice) / fillPrice * 100),
    takePct: takePrice === null ? null : Math.abs((takePrice - fillPrice) / fillPrice * 100), orderId,
    entryTime: entryTime ?? (data[index]?.[0] + BASE), modelConfigId: s.modelConfigId ?? null,
    engineVersion: s.activeEngineVersion ?? s.engineVersion ?? null, ...metadata,
    ...initialRiskFields(side, fillPrice, qty, stopPrice),
    initialTake: takePrice ?? null,
    riskBudget: {lossBudget: metadata.lossBudget ?? null, basis: 'user-entered-currency-amount', status: metadata.lossBudget == null ? 'not-provided' : 'provided'},
    pretradeRisk: {...riskAtEntry({side, notional, entry: fillPrice, stop: stopPrice, take: takePrice,
      basis: 'actual-fill', modelConfig: activeModelConfig(s), referencePrice: fillPrice}),
      reference: 'actual-fill', stop: stopPrice ?? null, margin: marginFor(notional, leverage), leverage}};
  if (entryReason !== undefined) position.entryReason = entryReason;
  s.position = position;
  s.balance -= entryFee;
  if (s.modelConfigId) {
    const fill = addEntryFill(s, {orderId, position, price: fillPrice, index, time: position.entryTime, executionType});
    appendLedger(s, data, 'entry-fee', {cashDelta: -entryFee, fee: entryFee, orderId, positionId, fillId: fill.id});
    if (position.marginMode === ISOLATED_MARGIN_MODE) appendLedger(s, data, 'margin-reserved', {marginDelta: position.margin, orderId, positionId, fillId: fill.id});
    appendAccountSnapshot(s, data, 'position-opened');
  }
  return position;
}

function recordFilledOrder(s, order, fillIndex, fillPrice, fillTime = undefined, position = null) {
  const entryFill = position && s.fills?.find(f => f.id === position.entryFillId);
  const record = {...order, ...(position?.marginMode === ISOLATED_MARGIN_MODE ? {marginMode: position.marginMode, leverage: position.leverage,
    margin: position.margin, liquidationPrice: position.liquidationPrice} : {}), status: 'filled', fillIndex, fillPrice,
    ...(entryFill ? {fillId: entryFill.id, positionId: position.positionId} : {}), ...(fillTime === undefined ? {} : {fillTime})};
  s.orderHistory ??= [];
  s.orderHistory.push(record);
  return record;
}

// Market orders fill at the already disclosed close. Limit orders stay pending
// until a future observed 15m candle touches their price.
export function placeOrder(s, data, side, notional, entryPrice, stopPrice, takePrice, orderType = 'market', entryReason = '', leverage = DEFAULT_LEVERAGE, metadata = {}) {
  const normalizedReason = normalizeEntryReason(entryReason), meta = normalizeMetadata(metadata);
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (s.position || s.pending) throw new Error('请先处理当前仓位或挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  if (!['market', 'limit'].includes(orderType)) throw new Error('订单类型无效');
  const currentPrice = replayPrice(s, data), eventIndex = visibleUpperIndex(s, data), eventTime = replayTime(s, data);
  const planPrice = orderType === 'market' ? currentPrice : entryPrice;
  validateOrderPlan(s, side, notional, planPrice, stopPrice, takePrice, leverage);
  const marketableLimit = orderType === 'limit' && (side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice);
  const orderRisk = estimateOrderRisk({side, notional, currentPrice, entryPrice: planPrice, stop: stopPrice, take: takePrice,
    orderType, modelConfig: activeModelConfig(s)});
  const orderId = crypto.randomUUID();
  const order = {id: orderId, modelConfigId: s.modelConfigId ?? null, engineVersion: s.activeEngineVersion ?? s.engineVersion ?? null,
    type: orderType, side, notional, entryPrice: planPrice, stop: stopPrice, take: takePrice,
    placedIndex: eventIndex, placedTime: eventTime, entryReason: normalizedReason, ...meta,
    riskBudget: {lossBudget: meta.lossBudget, basis: 'user-entered-currency-amount', status: meta.lossBudget == null ? 'not-provided' : 'provided'},
    pretradeRisk: {...orderRisk, reference: orderType === 'market' ? 'market-close-estimate' : 'limit-price-plan',
      referencePrice: planPrice, margin: marginFor(notional, leverage), leverage},
    ...withMargin(notional, leverage, planPrice, side)};
  if (orderType === 'market' || marketableLimit) {
    const fillPrice = orderType === 'market' ? currentPrice * (1 + side * SLIP) : limitFillAtCurrentPrice(side, currentPrice, entryPrice, SLIP);
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    s.orders ??= []; s.orders.push(order);
    const position = positionAtPrice(s, data, side, notional, fillPrice, stopPrice, takePrice, eventIndex, order.id, normalizedReason, eventTime, leverage, ISOLATED_MARGIN_MODE, meta, orderType === 'limit' ? 'marketable-limit-close' : 'market-close');
    const filled = recordFilledOrder(s, order, eventIndex, fillPrice, eventTime, position);
    return {status: 'filled', order: filled, position};
  }
  s.orders ??= []; s.orders.push(order);
  s.pending = {...order};
  if (s.modelConfigId) {
    const reserved = order.margin + order.notional * FEE;
    appendLedger(s, data, 'order-margin-reserved', {reservedMarginDelta: reserved, orderId: order.id});
    appendAccountSnapshot(s, data, 'order-submitted');
  }
  return {status: 'pending', order: s.pending};
}

export function cancelOrder(s, reason = '用户撤单', data = undefined) {
  if (!s?.pending) return null;
  const cancelledIndex = s.forming15m ? s.cursor + 1 : s.cursor;
  const cancelled = {...s.pending, status: 'cancelled', reason, cancelledIndex,
    ...(Number.isInteger(s.minuteCursorTime) ? {cancelledTime: s.minuteCursorTime + 60} : {})};
  s.orderHistory ??= [];
  s.orderHistory.push(cancelled);
  s.pending = null;
  if (s.modelConfigId) {
    const reserve = cancelled.marginMode === ISOLATED_MARGIN_MODE ? cancelled.margin + cancelled.notional * FEE : cancelled.notional * (1 + FEE);
    appendLedger(s, data, 'order-reservation-released', {reservedMarginDelta: -reserve, orderId: cancelled.id});
    appendAccountSnapshot(s, data, 'order-cancelled');
  }
  return cancelled;
}

export function updatePendingOrder(s, data, entryPrice, stopPrice, takePrice, metadata = {}) {
  const meta = normalizeMetadata(metadata);
  if (!validateSession(s, s?.symbol, data) || !s.pending) throw new Error('当前没有有效挂单');
  if (s.cursor >= s.end) throw new Error('本轮已结束，请开启新一轮');
  validateOrderPlan(s, s.pending.side, s.pending.notional, entryPrice, stopPrice, takePrice, s.pending.leverage ?? DEFAULT_LEVERAGE, s.pending.marginMode);
  const currentPrice = replayPrice(s, data), side = s.pending.side, eventIndex = visibleUpperIndex(s, data), eventTime = replayTime(s, data);
  const before = {entryPrice: s.pending.entryPrice, stop: s.pending.stop, take: s.pending.take};
  const updated = {...s.pending, entryPrice, stop: stopPrice, take: takePrice,
    ...(s.pending.marginMode === ISOLATED_MARGIN_MODE ? withMargin(s.pending.notional, s.pending.leverage, entryPrice, s.pending.side) : {}),
    modifiedIndex: eventIndex, modifiedTime: eventTime,
    pretradeRisk: {...estimateOrderRisk({side, notional: s.pending.notional, currentPrice, entryPrice, stop: stopPrice, take: takePrice,
      orderType: 'limit', modelConfig: activeModelConfig(s)}), reference: 'limit-price-plan', referencePrice: entryPrice}};
  const marketable = side === 1 ? entryPrice >= currentPrice : entryPrice <= currentPrice;
  if (marketable) {
    const fillPrice = limitFillAtCurrentPrice(side, currentPrice, entryPrice, SLIP);
    if (!protectionsBracket(side, fillPrice, stopPrice, takePrice)) throw new Error('止损和止盈必须分列在实际成交价两侧');
    s.pending = null;
    if (s.modelConfigId) {
      const reserved = updated.marginMode === ISOLATED_MARGIN_MODE ? updated.margin + updated.notional * FEE : updated.notional * (1 + FEE);
      appendLedger(s, data, 'order-reservation-released', {reservedMarginDelta: -reserved, orderId: updated.id});
    }
    const position = positionAtPrice(s, data, side, updated.notional, fillPrice, stopPrice, takePrice, eventIndex, updated.id, updated.entryReason, eventTime, updated.leverage ?? DEFAULT_LEVERAGE, updated.marginMode, updated, 'limit-repriced-marketable');
    const filled = recordFilledOrder(s, updated, eventIndex, fillPrice, eventTime, position);
    if (s.modelConfigId) recordRiskChange(s, data, 'order', updated, before, {entryPrice, stop: stopPrice, take: takePrice}, meta);
    return {status: 'filled', order: filled, position};
  }
  s.pending = updated;
  if (s.modelConfigId) recordRiskChange(s, data, 'order', updated, before, {entryPrice, stop: stopPrice, take: takePrice}, meta);
  return {status: 'pending', order: s.pending};
}

export function updateProtection(s, data, stopPrice, takePrice, metadata = {}) {
  const meta = normalizeMetadata(metadata);
  if (!validateSession(s, s?.symbol, data) || !s.position) throw new Error('当前没有有效持仓');
  if (!optionalPrice(stopPrice) || !optionalPrice(takePrice)) throw new Error('保护价格无效；关闭保护请传null');
  const price = replayPrice(s, data), p = s.position;
  if (!protectionsBracket(p.side, price, stopPrice, takePrice)) throw new Error('止盈止损必须分列在当前价格两侧');
  const modifiedIndex = visibleUpperIndex(s, data), modifiedTime = replayTime(s, data);
  const before = {stop: p.stop, take: p.take, initialStop: p.initialStop ?? null, initialTake: p.initialTake ?? null, initialRiskR0: p.initialRiskR0 ?? null};
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
  if (s.modelConfigId) recordRiskChange(s, data, 'position', p, before,
    {stop: stopPrice, take: takePrice, initialStop: p.initialStop ?? null, initialTake: p.initialTake ?? null, initialRiskR0: p.initialRiskR0 ?? null}, meta);
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

function exitPositionOnBar(s, data, c, index, entryBar = false, referenceIntervalSeconds = 60) {
  const p = s.position;
  if (!p) return null;
  const liquidation = p.marginMode === ISOLATED_MARGIN_MODE ? p.liquidationPrice : null;
  const gapLiquidation = Number.isFinite(liquidation) && (p.side === 1 ? c[1] <= liquidation : c[1] >= liquidation);
  if (gapLiquidation) return closeOnTrigger(s, data, c, index, c[1], '强平', 'liquidation', c[1], 'minute-gap-liquidation-v1', null, referenceIntervalSeconds);
  const gapStop = p.stop !== null && (p.side === 1 ? c[1] <= p.stop : c[1] >= p.stop);
  const hitStop = p.stop !== null && (p.side === 1 ? c[3] <= p.stop : c[2] >= p.stop);
  if (gapStop) return closeOnTrigger(s, data, c, index, c[1], '跳空止损', 'stop', c[1], 'minute-gap-stop-at-open-v1', null, referenceIntervalSeconds);
  const gapTake = p.take !== null && (p.side === 1 ? c[1] >= p.take : c[1] <= p.take);
  if (!entryBar && gapTake) return closeOnTrigger(s, data, c, index, c[1], '跳空止盈', 'take', c[1], 'minute-gap-take-at-open-v1', null, referenceIntervalSeconds);
  const hitLiquidation = Number.isFinite(liquidation) && (p.side === 1 ? c[3] <= liquidation : c[2] >= liquidation);
  const hitTake = p.take !== null && (p.side === 1 ? c[2] >= p.take : c[3] <= p.take);
  const ambiguous = (hitStop && hitTake) || (hitStop && hitLiquidation) || (hitTake && hitLiquidation);
  const stopIsCloser = hitLiquidation && p.stop !== null && (p.side === 1 ? p.stop >= liquidation : p.stop <= liquidation);
  const chosen = hitLiquidation && (!hitStop || !stopIsCloser) ? 'liquidation' : hitStop ? 'stop' : hitTake ? 'take' : null;
  const evidence = ambiguous ? {intrabarAmbiguous: true, affectedOrderIds: p.orderId ? [p.orderId] : [],
    ruleId: hitLiquidation ? '1m-ohlc-nearest-protective-threshold-v1' : '1m-ohlc-stop-first-v1',
    ruleVersion: s.activeEngineVersion ?? s.engineVersion ?? 'legacy-engine-unversioned', chosen} : null;
  if (hitLiquidation) {
    if (!hitStop || !stopIsCloser) return closeOnTrigger(s, data, c, index, liquidation, '强平', 'liquidation', liquidation,
      evidence?.ruleId ?? 'minute-intrabar-liquidation-v1', evidence, referenceIntervalSeconds);
  }
  if (hitStop) return closeOnTrigger(s, data, c, index, p.stop, hitTake ? '双触发，按止损' : entryBar ? '入场同根止损' : '止损',
    'stop', p.stop, evidence?.ruleId ?? 'minute-intrabar-stop-v1', evidence, referenceIntervalSeconds);
  if (entryBar) return null; // Intrabar order is unknown; defer take-profit to the next candle.
  if (hitTake) return closeOnTrigger(s, data, c, index, p.take, '止盈', 'take', p.take,
    evidence?.ruleId ?? 'minute-intrabar-take-v1', evidence, referenceIntervalSeconds);
  return null;
}

function closeOnTrigger(s, data, candle, index, exitPrice, reason, type, triggerPrice, ruleId, executionEvidence = null, referenceIntervalSeconds = 60) {
  const triggerEvidence = {type, triggerPrice, referenceMinute: candle[0], triggerMarketTime: candle[0] + referenceIntervalSeconds,
    referenceIntervalSeconds,
    ruleId, actualIntrabarOrderUnknown: true,
    ...(executionEvidence?.affectedOrderIds ? {affectedOrderIds: [...executionEvidence.affectedOrderIds]} : [])};
  return closePosition(s, data, exitPrice, reason, index, executionEvidence, triggerEvidence);
}

export function closePosition(s, data, price, reason = '手动平仓', index = undefined, executionEvidence = null, triggerEvidence = null) {
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
  const tradeId = crypto.randomUUID();
  const trade = {...p, id: tradeId, tradeId, positionId: p.positionId ?? crypto.randomUUID(), exit, exitIndex: index,
    exitTime: Number.isInteger(s.minuteCursorTime) ? replayTime(s, data) : legacyExitTime,
    entryTime: p.entryTime ?? assertCandle(data, p.entryIndex)[0] + BASE,
    pnl: settlement - p.entryFee, grossPnl: gross, exitFee, fees: p.entryFee + exitFee, reason,
    riskChanges: (s.riskChanges ?? []).filter(r => r.positionId === p.positionId || (p.orderId && r.orderId === p.orderId)),
    ...(executionEvidence ? {executionEvidence: structuredClone(executionEvidence)} : {}),
    ...(triggerEvidence ? {triggerEvidence: structuredClone(triggerEvidence)} : {}),
    ...(p.marginMode === ISOLATED_MARGIN_MODE ? {isolatedAdjustment} : {})};
  s.balance += settlement;
  s.trades.push(trade);
  s.position = null;
  if (s.modelConfigId) {
    const time = Number.isInteger(s.minuteCursorTime) ? replayTime(s, data) : legacyExitTime;
    const fill = addExitFill(s, trade, exit, index, time, reason === '手动平仓' ? 'manual-close' : reason === '本轮结束' ? 'session-end-close' : 'automatic-protection');
    appendLedger(s, data, 'exit-settlement', {cashDelta: settlement, grossPnl: gross, fee: exitFee, isolatedAdjustment,
      orderId: trade.orderId ?? null, positionId: trade.positionId, tradeId: trade.tradeId, fillId: fill.id,
      usedMarginAfter: p.marginMode === ISOLATED_MARGIN_MODE ? p.margin : 0});
    if (p.marginMode === ISOLATED_MARGIN_MODE) appendLedger(s, data, 'margin-released', {marginDelta: -p.margin,
      orderId: trade.orderId ?? null, positionId: trade.positionId, tradeId: trade.tradeId, fillId: fill.id});
    appendAccountSnapshot(s, data, 'position-closed');
  }
  return trade;
}

/** Close a position at the disclosed/manual execution price with a required user-supplied explanation. */
export function manualClosePosition(s, data, exitReason, price = undefined, index = undefined) {
  const normalizedReason = normalizeExitReason(exitReason);
  const trade = closePosition(s, data, price, '手动平仓', index);
  if (trade) trade.exitReason = normalizedReason;
  return trade;
}

// Walk underlying 15m bars in order. At an exact stop/take touch, stop wins;
// gaps fill from the bar open. Playback pauses at the exit for review.
export function advance(s, data) {
  if (!validateSession(s, s?.symbol, data)) throw new Error('本轮行情范围无效');
  if (Object.hasOwn(s, 'minuteCursorTime')) throw new Error('分钟回放状态请使用advanceMinute推进');
  if (s.cursor >= s.end) {
    const orderCancelled = s.pending ? cancelOrder(s, '本轮结束未成交', data) : null;
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
        if (s.modelConfigId) {
          const released = pending.marginMode === ISOLATED_MARGIN_MODE ? pending.margin + pending.notional * FEE : pending.notional * (1 + FEE);
          appendLedger(s, data, 'order-reservation-released', {reservedMarginDelta: -released, orderId: pending.id});
        }
        const fillTime = c[0] + BASE;
        positionAtPrice(s, data, pending.side, pending.notional, fillPrice, pending.stop, pending.take, i, pending.id, pending.entryReason, fillTime, pending.leverage ?? DEFAULT_LEVERAGE, pending.marginMode, pending, 'limit-touch-1m');
        orderFilled = recordFilledOrder(s, pending, i, fillPrice, fillTime, s.position);
        entryBar = true;
      }
    }
    if (s.position) trade = exitPositionOnBar(s, data, c, i, entryBar, BASE);
    if (trade || orderFilled || c[0] + BASE >= nextBoundary) break;
  }
  if (s.cursor === s.end && s.position) trade = closePosition(s, data, assertCandle(data, s.cursor)[4], '本轮结束', s.cursor);
  if (s.cursor === s.end && s.pending) orderCancelled = cancelOrder(s, '本轮结束未成交', data);
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
