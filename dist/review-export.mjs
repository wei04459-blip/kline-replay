import {readMinuteRange} from './minute-data.mjs';
import {buildReviewReport} from './review-report.mjs';

const BASE = 900;
const MINUTE = 60;
const WARMUP = 365 * 24 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;
const MONDAY_OFFSET = 4 * 24 * 60 * 60;
const SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);
const ZIP_LIMIT = 0xffffffff;
const SCREENSHOT_ACTIONS = new Set(['order-submitted', 'order-plan-locked', 'plan-supplemented', 'order-filled', 'order-processed', 'order-modified', 'order-cancelled',
  'order-history-changed', 'protection-changed', 'protection-modified', 'position-opened', 'position-close-requested',
  'position-closed', 'position-auto-closed', 'position-triggered', 'liquidated', 'observation-recorded']);

const utf8 = new TextEncoder();
const APP_ASSET_VERSION = new URL(import.meta.url).searchParams.get('v') || null;
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256，无法生成完整清单。');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function stripFormingDeep(value) {
  if (!value || typeof value !== 'object') return false;
  let changed = false;
  if (!Array.isArray(value) && Object.hasOwn(value, 'forming15m') && value.forming15m != null) {
    value.forming15m = null;
    value.marketDataRedactions = [...(Array.isArray(value.marketDataRedactions) ? value.marketDataRedactions : []),
      {field: 'forming15m', reason: '未完成原始15分钟K线可能含未揭示OHLCV；完整原值未导出'}];
    changed = true;
  }
  for (const child of Object.values(value)) if (stripFormingDeep(child)) changed = true;
  return changed;
}

function safeId(value, fallback) {
  const id = typeof value === 'string' && value ? value : fallback;
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || fallback;
}

function validCandle(row, interval) {
  if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(Number.isFinite)) return false;
  const [time, open, high, low, close, volume] = row;
  return Number.isInteger(time) && time >= 0 && time % interval === 0 &&
    Math.min(open, high, low, close) > 0 && volume >= 0 && high >= Math.max(open, close, low) &&
    low <= Math.min(open, close, high);
}

function iso(seconds) { return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null; }
function utcDay(seconds) { return new Date(seconds * 1000).toISOString().slice(0, 10); }
function nextDay(day) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
function weekOpen(seconds) { return Math.floor((seconds - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET; }

function sessionCutoff(session, rows) {
  if (Number.isInteger(session?.minuteCursorTime) && session.minuteCursorTime >= 0) return session.minuteCursorTime + MINUTE;
  const row = Number.isInteger(session?.cursor) ? rows[session.cursor] : null;
  return validCandle(row, BASE) ? row[0] + BASE : null;
}

function startBounds(session, rows, datasetRange) {
  const start = Number.isInteger(session?.start) ? session.start : -1;
  const startRow = rows[start];
  const sessionStart = Number.isFinite(session?.startTime) ? session.startTime
    : validCandle(startRow, BASE) ? startRow[0] + BASE : null;
  if (!Number.isFinite(sessionStart)) return {sessionStart: null, visibleFrom: null, replayFrom: null};
  const requestedVisibleFrom = weekOpen(Math.max(0, sessionStart - WARMUP));
  const availableStart = Number.isFinite(datasetRange?.start) ? datasetRange.start : 0;
  const visibleFrom = Math.max(availableStart, requestedVisibleFrom);
  return {sessionStart, visibleFrom, requestedVisibleFrom, availableStart,
    warmupMissingBars: Math.max(0, Math.ceil((availableStart - requestedVisibleFrom) / BASE)), replayFrom: sessionStart};
}

function normalizeDataset(payload, symbol, issues) {
  const object = Array.isArray(payload) ? {candles: payload} : payload;
  const input = object?.candles;
  if (!Array.isArray(input)) throw new Error(`${symbol} 的内置15分钟行情格式无效。`);
  const rows = [];
  let previous = -1, invalid = 0;
  for (const row of input) {
    if (!validCandle(row, BASE) || row[0] <= previous) { invalid += 1; continue; }
    rows.push(row.slice(0, 6));
    previous = row[0];
  }
  if (invalid) issues.push(`${symbol} 内置15分钟行情有 ${invalid} 行格式或顺序异常，已排除并标记。`);
  if (!rows.length) throw new Error(`${symbol} 没有可用的15分钟行情。`);
  return {rows, source: object, range: object.range ?? {start: rows[0][0], end: rows.at(-1)[0] + BASE}};
}

function modelEvidenceFor(session) {
  const configs = Array.isArray(session?.modelConfigs) ? session.modelConfigs : [];
  const referencedIds = new Set([
    ...(Array.isArray(session?.orders) ? session.orders : []).map(item => item?.modelConfigId),
    ...(Array.isArray(session?.fills) ? session.fills : []).map(item => item?.modelConfigId),
    ...(Array.isArray(session?.trades) ? session.trades : []).map(item => item?.modelConfigId),
  ].filter(id => typeof id === 'string'));
  if (!referencedIds.size && typeof session?.modelConfigId === 'string') referencedIds.add(session.modelConfigId);
  const evidenceConfigs = configs.filter(config => (!config?.baselineOnly || referencedIds.has(config?.modelConfigId)) &&
    (!referencedIds.size || referencedIds.has(config?.modelConfigId)));
  const configRates = evidenceConfigs.map(config => ({config,
    feeRate: config?.fee?.closeRate, slippageRate: config?.slippage?.rate,
    maintenanceMarginRate: config?.margin?.maintenanceRate})).filter(item =>
    Number.isFinite(item.feeRate) && item.feeRate >= 0 && Number.isFinite(item.slippageRate) && item.slippageRate >= 0 &&
    Number.isFinite(item.maintenanceMarginRate) && item.maintenanceMarginRate >= 0 && item.maintenanceMarginRate < 1);
  if (configRates.length) {
    const tradeConfig = trade => {
      const orderId = trade?.orderId;
      const fill = (session?.fills ?? []).find(item => item?.side === 'entry' &&
        (item.tradeId === trade?.id || item.positionId === trade?.positionId || (!!orderId && item.orderId === orderId)));
      const order = (session?.orders ?? []).find(item => item?.id === orderId || item?.orderId === orderId);
      const id = trade?.modelConfigId ?? fill?.modelConfigId ?? order?.modelConfigId;
      const config = configs.find(item => item?.modelConfigId === id);
      const entry = Number.isFinite(trade?.entryTime) ? trade.entryTime : Number.isFinite(fill?.time) ? fill.time :
        Number.isFinite(order?.fillTime) ? order.fillTime : null;
      const effective = Number.isFinite(config?.effectiveFrom?.replayMarketTime) ? config.effectiveFrom.replayMarketTime : null;
      return !!config && !!id && (!config.effectiveFrom || entry !== null && effective !== null && entry >= effective);
    };
    const unresolvedTrades = (session?.trades ?? []).filter(trade => !tradeConfig(trade));
    const signatures = new Set(configRates.map(item => `${item.feeRate}/${item.slippageRate}/${item.maintenanceMarginRate}`));
    if (signatures.size === 1 && unresolvedTrades.length === 0) {
      const {config, feeRate, slippageRate, maintenanceMarginRate} = configRates[0];
      return {applicableToSession: true, modelConfigId: config.modelConfigId, engineVersion: config.engineVersion,
        feeRate, slippageRate, maintenanceMarginRate, source: 'session-model-config',
        effectiveFrom: config.effectiveFrom ?? null,
        applicabilityReason: configRates.length > 1 ? '本轮引用的模型配置费率一致。' : null};
    }
    return {applicableToSession: false, feeRate: null, slippageRate: null, maintenanceMarginRate: null,
      source: 'mixed-or-unverified-session-model-configs', applicabilityReason: unresolvedTrades.length
        ? '部分交易未关联适用生效时间内的模型配置' : '会话引用了不同费率的模型配置；总体费率不合并。'};
  }
  if (configs.length) return {applicableToSession: false, feeRate: null, slippageRate: null,
    maintenanceMarginRate: null, source: 'unknown-or-unreferenced-model-config',
    applicabilityReason: '旧交易没有引用可证明的模型配置；升级基线只适用于其生效后明确关联的操作。'};
  if (session?.modelEvidence?.applicableToSession === false) return {...session.modelEvidence,
    feeRate: null, slippageRate: null, maintenanceMarginRate: null,
    source: session.modelEvidence.source ?? 'explicitly-not-applicable'};
  const model = session?.modelEvidence?.applicableToSession === true ? session.modelEvidence : session?.simulationModel;
  const ratesValid = model && Number.isFinite(model.feeRate) && model.feeRate >= 0 &&
    Number.isFinite(model.slippageRate) && model.slippageRate >= 0 &&
    Number.isFinite(model.maintenanceMarginRate) && model.maintenanceMarginRate >= 0 && model.maintenanceMarginRate < 1;
  const timestampValid = typeof model?.recordedAt === 'string' && Number.isFinite(Date.parse(model.recordedAt));
  const identityValid = typeof model?.id === 'string' && typeof model?.marketProduct === 'string' && typeof model?.executionModel === 'string';
  if (!ratesValid || (!identityValid || !timestampValid) && session?.modelEvidence?.applicableToSession !== true)
    return {applicableToSession: false, feeRate: null, slippageRate: null, maintenanceMarginRate: null,
    source: 'unknown', applicabilityReason: '本轮快照没有可核验的创建时模拟模型配置；不以当前引擎值补写历史。'};
  return {applicableToSession: true, id: model.id ?? null, version: model.version ?? null,
    marketProduct: model.marketProduct ?? null, executionModel: model.executionModel ?? null,
    feeRate: model.feeRate, slippageRate: model.slippageRate, maintenanceMarginRate: model.maintenanceMarginRate,
    sizeBudgetSemantics: model.sizeBudgetSemantics ?? null,
    recordedAt: model.recordedAt ?? null, source: 'session-creation-snapshot', applicabilityReason: null};
}

function commonModelRates(sessions) {
  if (!sessions.length || sessions.some(item => item.modelEvidence?.applicableToSession !== true)) {
    return {feeRate: null, slippageRate: null, maintenanceMarginRate: null,
      modelRatesApplicability: '至少一个轮次没有适用该历史的明确模型快照；总体费率不提供。'};
  }
  const keys = ['feeRate', 'slippageRate', 'maintenanceMarginRate'];
  const result = {};
  for (const key of keys) {
    const values = new Set(sessions.map(item => item.modelEvidence[key]));
    result[key] = values.size === 1 ? sessions[0].modelEvidence[key] : null;
    if (values.size !== 1) return {feeRate: null, slippageRate: null, maintenanceMarginRate: null,
      modelRatesApplicability: '纳入的轮次模拟配置不同；总体费率不合并。'};
  }
  result.modelRatesApplicability = '所有纳入轮次均有相同且明确适用的创建时模型快照。';
  return result;
}

function findGaps(rows, interval, type) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const missing = Math.floor((rows[i][0] - rows[i - 1][0]) / interval) - 1;
    if (missing > 0) gaps.push({type, from: rows[i - 1][0] + interval, to: rows[i][0] - interval,
      missingBars: missing, fromUtc: iso(rows[i - 1][0] + interval), toUtc: iso(rows[i][0] - interval)});
  }
  return gaps;
}

function postExitWindows(trade, minuteCandles, cutoff) {
  const exitTime = Number.isFinite(trade?.exitTime) ? trade.exitTime :
    typeof trade?.exitTime === 'string' && Number.isFinite(Date.parse(trade.exitTime)) ? Date.parse(trade.exitTime) / 1000 : null;
  if (exitTime === null) return [900, 3600, 14400].map(durationSeconds => ({durationSeconds, status: 'unavailable',
    reason: '交易缺少可核验的退出行情时间。', candles: []}));
  const from = Math.ceil(exitTime / MINUTE) * MINUTE; // Exclude the minute containing the exit event.
  return [900, 3600, 14400].map(durationSeconds => {
    const to = exitTime + durationSeconds;
    const expectedTimes = [];
    for (let time = from; time + MINUTE <= to; time += MINUTE) expectedTimes.push(time);
    const candles = minuteCandles.filter(row => row[0] >= from && row[0] + MINUTE <= to && row[0] + MINUTE <= cutoff);
    const observedTimes = new Set(candles.map(row => row[0]));
    const missingOpenTimes = expectedTimes.filter(time => time + MINUTE <= cutoff && !observedTimes.has(time));
    const complete = cutoff >= to && candles.length === expectedTimes.length && candles.every((row, index) => row[0] === expectedTimes[index]);
    const gap = candles.length !== expectedTimes.filter(time => time + MINUTE <= cutoff).length;
    return {durationSeconds, visibleFrom: from, windowEnd: to, visibleThrough: Math.min(cutoff, to),
      status: complete ? 'complete' : cutoff < to ? 'pending' : gap ? 'coverage-gap' : 'incomplete',
      expectedMinuteRows: expectedTimes.length,
      availableMinuteRows: candles.length, dataRef: 'session.market.minuteCandles', missingOpenTimes,
      observedSummary: candles.length ? {firstOpen: candles[0][1], highest: Math.max(...candles.map(row => row[2])),
        lowest: Math.min(...candles.map(row => row[3])), lastClose: candles.at(-1)[4], volumeBase: candles.reduce((sum, row) => sum + row[5], 0)} : null,
      note: '固定市场时间窗口；排除包含退出事件的分钟，不生成反事实盈亏或行为评分。'};
  });
}

function evidenceCoverageFor(session, events) {
  const plans = Array.isArray(session?.reviewPlans) ? session.reviewPlans : [];
  const orders = Array.isArray(session?.orders) ? session.orders : [];
  const fills = Array.isArray(session?.fills) ? session.fills : [];
  const trades = Array.isArray(session?.trades) ? session.trades : [];
  const configs = Array.isArray(session?.modelConfigs) ? session.modelConfigs : [];
  const ordersById = new Map(orders.map(order => [order.id, order]));
  const plansById = new Map(plans.map(plan => [plan.planId, plan]));
  const fillsById = new Map(fills.map(fill => [fill.id, fill]));
  const configIds = new Set(configs.map(config => config.modelConfigId));
  const tradeIds = new Set(trades.flatMap(trade => [trade.id, trade.tradeId]).filter(Boolean));
  const planIds = new Set(plans.map(plan => plan.planId).filter(Boolean));
  const thesisIds = new Set((session?.theses ?? []).map(thesis => thesis.thesisId).filter(Boolean));
  const eventSnapshotIds = new Set((events ?? []).map(event => event.snapshotId).filter(Boolean));
  const positionIds = new Set([...trades.map(trade => trade.positionId), session?.position?.positionId].filter(Boolean));
  const modelBoundary = session?.modelEvidenceStart?.visibleThrough ?? session?.modelEvidenceStart?.replayMarketTime;
  const captureReplayStart = typeof modelBoundary === 'number' && Number.isFinite(modelBoundary) && modelBoundary >= 0 ? modelBoundary : null;
  const missingEventRefs = events.filter(event =>
    event.orderId && !ordersById.has(event.orderId) && !(session?.orderHistory ?? []).some(order => order.id === event.orderId) ||
    event.tradeId && !tradeIds.has(event.tradeId) && session?.position?.tradeId !== event.tradeId ||
    event.planId && !planIds.has(event.planId)).map(event => event.id ?? event.seq ?? 'unknown');
  const modelReferences = [...orders, ...fills, ...trades].filter(item => item.modelConfigId || session.engineVersion);
  const missingModels = modelReferences.filter(item => typeof item.modelConfigId !== 'string' || !configIds.has(item.modelConfigId)).length;
  const linkedPlans = orders.filter(order => order.planId && plansById.has(order.planId)).length;
  const missingPlanReferences = orders.filter(order => !order.planId || !plansById.has(order.planId)).length;
  const ordersByIdForTrades = new Map(orders.map(order => [order.id, order]));
  const missingOrderTradeIds = trades.filter(trade => !trade.orderId || !ordersByIdForTrades.has(trade.orderId))
    .map(trade => trade.id ?? trade.tradeId ?? 'unknown');
  const linkedCapturedTradeCount = captureReplayStart === null ? null : trades.filter(trade =>
    Number.isFinite(trade.entryTime) && trade.entryTime >= captureReplayStart && trade.orderId && ordersByIdForTrades.has(trade.orderId)).length;
  const expectedCapturedTradeCount = captureReplayStart === null ? null : trades.filter(trade =>
    Number.isFinite(trade.entryTime) && trade.entryTime >= captureReplayStart).length;
  const historicalTradeCount = captureReplayStart === null ? null : trades.filter(trade =>
    Number.isFinite(trade.entryTime) && trade.entryTime < captureReplayStart).length;
  const missingPlanSnapshots = plans.filter(plan => {
    const visible = plan.visibleThrough;
    const validTime = typeof visible === 'number' ? Number.isFinite(visible) && visible >= 0
      : typeof visible === 'string' && visible.trim() !== '' && Number.isFinite(Date.parse(visible));
    return !validTime || typeof plan.snapshotId !== 'string' || !eventSnapshotIds.has(plan.snapshotId);
  }).length;
  const missingThesisReferences = [
    ...orders.filter(order => order.thesisId && !thesisIds.has(order.thesisId)).map(order => `order:${order.id}:thesis:${order.thesisId}`),
    ...trades.filter(trade => trade.thesisId && !thesisIds.has(trade.thesisId)).map(trade => `trade:${trade.id}:thesis:${trade.thesisId}`),
    ...(session?.observations ?? []).filter(item => item.thesisId && !thesisIds.has(item.thesisId)).map(item => `observation:${item.observationId}:thesis:${item.thesisId}`),
  ];
  const missingFillLinks = trades.filter(trade => {
    const entry = fillsById.get(trade.entryFillId), exit = fillsById.get(trade.exitFillId);
    return !entry || entry.side !== 'entry' || !exit || exit.side !== 'exit' || exit.tradeId !== (trade.tradeId ?? trade.id);
  }).length;
  const keyEvents = events.filter(event => SCREENSHOT_ACTIONS.has(event.kind));
  const missingSnapshots = keyEvents.filter(event => !event.snapshotId || !event.view || typeof event.view !== 'object').length;
  const drawingEvents = events.filter(event => String(event.kind ?? '').startsWith('drawing-'));
  const currentDrawings = Array.isArray(session?.drawings) ? session.drawings : null;
  const currentDrawingIds = new Set((currentDrawings ?? []).map(drawing => drawing?.id)
    .filter(id => typeof id === 'string' && id.length > 0));
  const eventDrawingIds = new Set(), afterDrawingIds = new Set();
  for (const event of drawingEvents) {
    for (const key of ['before', 'after']) {
      const drawings = event?.[key]?.drawings;
      if (!Array.isArray(drawings)) continue;
      for (const drawing of drawings) {
        if (typeof drawing?.id !== 'string' || !drawing.id) continue;
        eventDrawingIds.add(drawing.id);
        if (key === 'after') afterDrawingIds.add(drawing.id);
      }
    }
    for (const id of [event.drawingId, event.references?.drawingId])
      if (typeof id === 'string' && id) eventDrawingIds.add(id);
  }
  const currentDrawingCount = currentDrawings?.length ?? null;
  const currentDrawingIdList = [...currentDrawingIds].sort();
  const eventDrawingIdList = [...eventDrawingIds].sort();
  const eventBackedCurrentIds = currentDrawingIdList.filter(id => afterDrawingIds.has(id));
  const currentStateOnlyIds = currentDrawingIdList.filter(id => !afterDrawingIds.has(id));
  const eventOnlyIds = eventDrawingIdList.filter(id => !currentDrawingIds.has(id));
  const unidentifiedCurrentDrawingCount = currentDrawings
    ? currentDrawings.filter(drawing => typeof drawing?.id !== 'string' || !drawing.id).length : null;
  const drawingVersions = Array.isArray(session?.drawingVersions) ? session.drawingVersions : null;
  const observedLedger = Array.isArray(session?.ledger) ? session.ledger : null;
  let ledgerValid = !!observedLedger?.length;
  let ledgerFullHistoryVerified = !!observedLedger?.length;
  let ledgerSegment = null;
  if (ledgerValid) {
    const ordered = [...observedLedger].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const legacyBaselineIndex = ordered.findIndex(row => row?.type === 'legacy-baseline' || row?.legacyHistoryUnknown === true);
    if (legacyBaselineIndex >= 0) {
      ledgerFullHistoryVerified = false;
      ledgerSegment = {startSeq: ordered[legacyBaselineIndex].seq ?? null,
        startReplayMarketTime: ordered[legacyBaselineIndex].replayMarketTime ?? null,
        startVisibleThrough: ordered[legacyBaselineIndex].visibleThrough ?? null,
        openingBalance: ordered[legacyBaselineIndex].balanceAfter ?? null,
        historicalBeforeStart: 'unknown'};
    }
    const ledgerIds = new Set();
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index];
      if (!row || typeof row.id !== 'string' || ledgerIds.has(row.id) || row.seq !== index + 1 ||
          ![row.cashDelta, row.balanceAfter, row.equityAfter, row.usedMarginAfter].every(Number.isFinite)) { ledgerValid = false; break; }
      ledgerIds.add(row.id);
      if (index === 0) {
        if (legacyBaselineIndex === 0) {
          if (!row.legacyHistoryUnknown && row.type !== 'legacy-baseline') ledgerValid = false;
          if (!Number.isFinite(row.balanceAfter)) ledgerValid = false;
          if (row.baselineBalance !== undefined || row.cashDelta !== undefined) {
            if (!Number.isFinite(row.baselineBalance) || !Number.isFinite(row.cashDelta) ||
                Math.abs(row.baselineBalance + row.cashDelta - row.balanceAfter) > 0.02) ledgerValid = false;
          }
        } else if (!Number.isFinite(row.baselineBalance) || Math.abs(row.baselineBalance + row.cashDelta - row.balanceAfter) > 0.02) ledgerValid = false;
      } else if (Math.abs(ordered[index - 1].balanceAfter + row.cashDelta - row.balanceAfter) > 0.02) ledgerValid = false;
      if (row.fillId && !fillsById.has(row.fillId)) ledgerValid = false;
      if (row.orderId && !ordersById.has(row.orderId)) ledgerValid = false;
      if (row.tradeId && !tradeIds.has(row.tradeId)) ledgerValid = false;
      if (row.positionId && !positionIds.has(row.positionId)) ledgerValid = false;
    }
    const first = ordered[0];
    const last = ordered.at(-1);
    if (legacyBaselineIndex < 0 && (!Number.isFinite(session.initialBalance) ||
        !Number.isFinite(first?.baselineBalance) || Math.abs(first.baselineBalance - session.initialBalance) > 0.02)) ledgerValid = false;
    if (!Number.isFinite(session.balance) || Math.abs(last.balanceAfter - session.balance) > 0.02) ledgerValid = false;
    if (ledgerSegment) ledgerSegment.endingBalance = Number.isFinite(last?.balanceAfter) ? last.balanceAfter : null;
  }
  const evidence = {
    modelConfigs: {status: !session.engineVersion ? 'unknown-legacy' : missingModels ? 'incomplete' : configs.length ? 'complete' : 'missing',
      expected: modelReferences.length, available: modelReferences.length - missingModels, missing: missingModels},
    immutableOrders: {status: !session.engineVersion ? 'unknown-legacy' : !Array.isArray(session.orders) ? 'missing'
      : missingOrderTradeIds.length ? captureReplayStart !== null && linkedCapturedTradeCount === expectedCapturedTradeCount ? 'partial-history' : 'incomplete'
        : 'complete',
      scope: captureReplayStart === null ? 'all-recorded-trades; capture boundary unavailable' : 'full history plus post-baseline collection range',
      captureReplayStart, captureReplayStartUtc: iso(captureReplayStart),
      expected: trades.length, available: trades.length - missingOrderTradeIds.length, missingTradeIds: missingOrderTradeIds,
      capturedRangeExpected: expectedCapturedTradeCount, capturedRangeAvailable: linkedCapturedTradeCount,
      preCaptureHistoricalTradeCount: historicalTradeCount},
    fills: {status: !session.engineVersion ? 'unknown-legacy' : missingFillLinks ? 'incomplete' : Array.isArray(session.fills) ? 'complete' : 'missing',
      expected: trades.length * 2, available: fills.length, missingTradeLinks: missingFillLinks},
    ledger: {status: !session.engineVersion ? 'unknown-legacy' : !ledgerValid ? 'incomplete'
      : ledgerFullHistoryVerified ? 'complete' : 'partial-history',
      available: observedLedger?.length ?? 0, missingOrInvalidReferences: ledgerValid ? 0 : 1,
      fullHistoryVerified: ledgerFullHistoryVerified, verifiedSegment: ledgerSegment},
    riskChanges: {status: !session.engineVersion ? 'unknown-legacy' : Array.isArray(session.riskChanges) ? 'present' : 'missing',
      available: session.riskChanges?.length ?? 0},
    plans: {status: !session.engineVersion ? 'unknown-legacy' : missingPlanReferences || missingPlanSnapshots ? 'incomplete' : plans.length ? 'present' : orders.length ? 'incomplete' : 'not-applicable',
      expected: orders.length, available: linkedPlans, missingReferences: missingPlanReferences, missingSnapshotsOrTimes: missingPlanSnapshots},
    snapshots: {status: !session.engineVersion ? 'unknown-legacy' : missingSnapshots ? 'incomplete' : keyEvents.length ? 'complete' : 'not-applicable',
      expected: keyEvents.length, available: keyEvents.length - missingSnapshots, missing: missingSnapshots},
    references: {status: !session.engineVersion ? 'unknown-legacy' : missingEventRefs.length || missingThesisReferences.length ? 'incomplete' : 'complete',
      missingEventRefs, missingThesisReferences},
    drawings: {status: drawingVersions ? 'present' : currentDrawingCount === 0 && drawingEvents.length === 0 ? 'not-applicable'
      : currentDrawingCount > 0 && currentStateOnlyIds.length === 0 && unidentifiedCurrentDrawingCount === 0
        ? 'event-backed-range'
        : currentDrawingCount > 0 && eventDrawingIds.size > 0 ? 'event-backed-partial'
          : currentDrawingCount > 0 ? 'state-only-incomplete'
            : eventDrawingIds.size > 0 ? 'event-backed-range' : drawingEvents.length ? 'event-only-incomplete' : 'not-applicable',
      currentDrawingCount, currentDrawingIds: currentDrawingIdList,
      eventBackedCurrentCount: eventBackedCurrentIds.length, eventBackedCurrentIds,
      currentStateOnlyIds, eventOnlyIds, unidentifiedCurrentDrawingCount,
      createdOrChangedEventCount: drawingEvents.length, eventEvidenceIdCount: eventDrawingIds.size,
      eventEvidenceIds: eventDrawingIdList, versionRows: drawingVersions?.length ?? null,
      collection: drawingVersions ? 'drawingVersions' : drawingEvents.length ? 'version facts are event-backed; no dedicated drawingVersions collection' : 'no version collection',
      scope: '当前状态ID与已导出drawing事件after快照逐一匹配；事件前状态和删除记录单列；未被事件覆盖的旧绘图仍可能未知'},
    theses: {status: Array.isArray(session.theses) ? 'present' : 'unknown-legacy', available: session.theses?.length ?? 0},
    observations: {status: Array.isArray(session.observations) ? 'present' : 'unknown-legacy', available: session.observations?.length ?? 0},
  };
  const required = ['modelConfigs', 'immutableOrders', 'fills', 'ledger', 'riskChanges', 'plans', 'snapshots', 'references', 'drawings'];
  const complete = required.every(key => ['complete', 'present', 'not-applicable', 'event-backed-range'].includes(evidence[key].status));
  return {evidence, evidenceComplete: complete};
}

function monthKey(url) {
  return String(url || '').match(/-(\d{4})-(\d{2})\.zip(?:\.CHECKSUM)?$/)?.slice(1).join('-') ?? null;
}

async function digestRows(rows) { return sha256(utf8.encode(JSON.stringify(rows))); }

function collectRoundInputs(current, history) {
  const result = [];
  const seen = new Map();
  const duplicates = [];
  const add = input => {
    const stableId = input.id == null ? null : String(input.id);
    if (stableId && seen.has(stableId)) { duplicates.push({id: stableId, keptSlot: seen.get(stableId), skippedSlot: input.slot}); return; }
    if (stableId) seen.set(stableId, input.slot);
    result.push(input);
  };
  if (current) add({slot: 'current', id: current.id, session: clone(current), archivedAt: null});
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    if (!item || typeof item !== 'object') {
      add({slot: `history-${index}`, id: null, rawInvalidRecord: clone(item), session: null, archivedAt: null});
      continue;
    }
    add({slot: `history-${index}`, id: item.id ?? item.session?.id ?? null,
      session: item.session ? clone(item.session) : null, archivedAt: item.archivedAt ?? null,
      imported: item.imported === true || item.sourceMetadata?.origin === 'review-zip-import' || item.sourceMetadata?.origin === 'v1-import',
      rawInvalidRecord: item.session ? undefined : clone(item)});
  }
  result.duplicates = duplicates;
  return result;
}

function stableEventCopy(event, roundCutoff, issues) {
  const copied = clone(event);
  const time = copied.visibleThrough;
  const visibleThrough = typeof time === 'string' ? Date.parse(time) / 1000 : time;
  if (!Number.isFinite(visibleThrough) || visibleThrough < 0) {
    copied.visibleThrough = null;
    copied.informationSet = null;
    issues.push(`事件 ${copied.id ?? copied.seq ?? '未知'} 缺少有效的可见行情截止时间。`);
  } else {
    if (visibleThrough > roundCutoff) {
      copied.visibleThrough = roundCutoff;
      issues.push(`事件 ${copied.id ?? copied.seq ?? '未知'} 的可见截止晚于练习快照，已限制到快照时间。`);
    } else copied.visibleThrough = Math.floor(visibleThrough);
  }
  return copied;
}

function coalesceTimes(missing, interval, typeByTime) {
  const gaps = [];
  let start = null, previous = null, currentType = null, count = 0;
  const flush = () => {
    if (start === null) return;
    gaps.push({type: currentType, from: start, to: previous, fromUtc: iso(start), toUtc: iso(previous), missingBars: count});
    start = null; previous = null; currentType = null; count = 0;
  };
  for (const time of missing) {
    const type = typeByTime.get(time) ?? 'minute_archive_incomplete';
    if (start === null || type !== currentType || time !== previous + interval) {
      flush(); start = time; currentType = type; count = 0;
    }
    previous = time; count += 1;
  }
  flush();
  return gaps;
}

function buildPartialIndex(minutes) {
  const buckets = new Map();
  for (const row of minutes) {
    const bucket = Math.floor(row[0] / BASE) * BASE;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(row);
  }
  return buckets;
}

function expectedPartial(index, cutoff) {
  if (!Number.isFinite(cutoff) || cutoff <= 0) return null;
  const open = Math.floor((cutoff - 1) / BASE) * BASE;
  const rows = (index.get(open) ?? []).filter(row => row[0] + MINUTE <= cutoff);
  if (!rows.length) return null;
  return [open, rows[0][1], Math.max(...rows.map(row => row[2])), Math.min(...rows.map(row => row[3])),
    rows.at(-1)[4], rows.reduce((sum, row) => sum + row[5], 0)];
}

function partialMatches(candidate, expected) {
  if (!Array.isArray(candidate) || candidate.length < 6 || !expected) return false;
  return candidate.slice(0, 6).every((value, index) => Number.isFinite(value) &&
    Math.abs(value - expected[index]) <= 1e-10 * Math.max(1, Math.abs(expected[index])));
}

function redactForming(target, reason) {
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, 'forming15m')) return;
  target.forming15m = null;
  const existing = Array.isArray(target.marketDataRedactions) ? target.marketDataRedactions : [];
  if (!existing.some(item => item?.field === 'forming15m')) {
    target.marketDataRedactions = [...existing, {field: 'forming15m', reason}];
  }
}

function redactUnverifiedPartial(target, cutoff, partialIndex, issues, label) {
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, 'forming15m') || target.forming15m == null) return;
  const expected = expectedPartial(partialIndex, cutoff);
  if (!partialMatches(target.forming15m, expected)) {
    redactForming(target, '原始未完成15分钟K线无法由该时点已揭示分钟核实；完整OHLCV未导出。');
    issues.push(`${label}的未完成15分钟K线无法由该时点已揭示分钟核实，已从复盘快照中排除。`);
  }
}

function redactFutureOutcomes(target, cutoff, rows, issues, label) {
  if (!target || typeof target !== 'object' || !Number.isFinite(cutoff)) return 0;
  let count = 0;
  const epoch = value => typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) / 1000 : Number(value);
  const originalRiskChanges = Array.isArray(target.riskChanges) ? target.riskChanges : [];
  const riskTime = item => {
    for (const value of [item?.visibleThrough, item?.replayMarketTime, item?.time]) {
      if (value === null || value === undefined || value === '') continue;
      const parsed = typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) / 1000 : Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };
  const visibleRiskChange = (orderId, positionId) => originalRiskChanges.filter(change =>
    (orderId && change.orderId === orderId || positionId && change.positionId === positionId) &&
    riskTime(change) !== null && riskTime(change) <= cutoff).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(-1);
  const scrubRiskHistory = item => {
    if (!Array.isArray(item.riskChanges)) return;
    item.riskChanges = item.riskChanges.filter(change => riskTime(change) === null || riskTime(change) <= cutoff);
  };
  const redact = (item, kind) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const modifiedTime = item.modifiedTime == null ? NaN : epoch(item.modifiedTime);
    if (Number.isFinite(modifiedTime) && modifiedTime > cutoff) {
      const previous = visibleRiskChange(item.orderId ?? item.id, item.positionId);
      if (previous?.after && typeof previous.after === 'object') {
        if (Object.hasOwn(previous.after, 'stop')) item.stop = previous.after.stop;
        if (Object.hasOwn(previous.after, 'take')) item.take = previous.after.take;
      } else {
        if (Object.hasOwn(item, 'stop')) item.stop = kind === 'trade' && Object.hasOwn(item, 'initialStop') ? item.initialStop : null;
        if (Object.hasOwn(item, 'take')) item.take = kind === 'trade' && Object.hasOwn(item, 'initialTake') ? item.initialTake : null;
      }
      delete item.modifiedTime; delete item.modifiedAt;
      item.futureProtectionRedacted = true;
      count += 1;
      issues.push(`${label}含有晚于披露边界的保护价修改，已还原到可证的保护状态。`);
    }
    scrubRiskHistory(item);
    const cancelTime = item.cancelledTime ?? item.canceledTime ?? item.cancelTime;
    const cancelIndex = item.cancelledIndex ?? item.canceledIndex;
    const cancelRow = Number.isInteger(cancelIndex) ? rows[cancelIndex] : null;
    const cancelledAt = cancelTime == null ? (validCandle(cancelRow, BASE) ? cancelRow[0] + BASE : NaN) : epoch(cancelTime);
    if (kind === 'order' && Number.isFinite(cancelledAt) && cancelledAt > cutoff) {
      for (const field of ['cancelledTime', 'canceledTime', 'cancelTime', 'cancelledIndex', 'canceledIndex', 'cancelReason']) delete item[field];
      if (item.status === 'cancelled' || item.status === 'canceled') item.status = 'pending';
      item.futureCancellationRedacted = true;
      count += 1;
      issues.push(`${label}含有晚于披露边界的撤单结果，已恢复为当时尚未撤销的状态。`);
    }
    let after = false;
    const rawTime = item.exitTime ?? item.fillTime ?? item.filledAt;
    const exitTime = rawTime == null ? NaN : epoch(rawTime);
    if (Number.isFinite(exitTime)) after = exitTime > cutoff;
    else if (Number.isInteger(item.exitIndex)) {
      const row = rows[item.exitIndex];
      after = validCandle(row, BASE) && row[0] + BASE > cutoff;
    } else if (kind === 'order' && Number.isInteger(item.fillIndex)) {
      const row = rows[item.fillIndex];
      after = validCandle(row, BASE) && row[0] + BASE > cutoff;
    }
    if (!after) return;
    const fields = kind === 'trade'
      ? ['exit', 'exitTime', 'exitIndex', 'reason', 'exitReason', 'pnl', 'fees', 'grossPnl', 'exitFee', 'isolatedAdjustment']
      : ['fillTime', 'filledAt', 'fillPrice', 'fillQty', 'fillIndex', 'averagePrice'];
    for (const field of fields) if (Object.hasOwn(item, field)) item[field] = null;
    if (kind === 'order' && Object.hasOwn(item, 'status')) item.status = 'pending';
    item.futureOutcomeRedacted = true;
    count += 1;
    issues.push(`${label}含有晚于该时点的${kind === 'trade' ? '成交结果' : '订单结果'}，其结果字段已脱敏。`);
  };
  const asOfOpen = [];
  if (Array.isArray(target.trades)) {
    const retained = [];
    for (const trade of target.trades) {
      const exitValue = trade?.exitTime;
      const exitTime = exitValue == null ? NaN : epoch(exitValue);
      const entryTime = epoch(trade?.entryTime ?? trade?.entryTimeSec);
      if (Number.isFinite(exitTime) && exitTime > cutoff && Number.isFinite(entryTime) && entryTime <= cutoff) {
        const open = clone(trade);
        for (const field of ['id', 'tradeId', 'exit', 'exitTime', 'exitIndex', 'reason', 'exitReason', 'pnl', 'fees', 'grossPnl',
          'exitFee', 'isolatedAdjustment', 'exitFillId', 'executionEvidence', 'triggerEvidence', 'closeReason', 'status', 'closedAt', 'exitType']) delete open[field];
        open.entryTime = entryTime;
        open.asOfOpenPosition = true;
        open.riskChanges = originalRiskChanges.filter(change =>
          (change.orderId === open.orderId || change.positionId === open.positionId) && riskTime(change) !== null && riskTime(change) <= cutoff);
        const previous = visibleRiskChange(open.orderId, open.positionId);
        if (previous?.after && typeof previous.after === 'object') {
          if (Object.hasOwn(previous.after, 'stop')) open.stop = previous.after.stop;
          if (Object.hasOwn(previous.after, 'take')) open.take = previous.after.take;
        } else {
          if (Object.hasOwn(open, 'initialStop')) open.stop = open.initialStop;
          if (Object.hasOwn(open, 'initialTake')) open.take = open.initialTake;
        }
        scrubRiskHistory(open);
        asOfOpen.push(open);
        issues.push(`${label}的一笔交易在截止后才退出；导出中按当时仍持仓处理，隐藏未来退出与盈亏。`);
        count += 1;
      } else {
        redact(trade, 'trade');
        retained.push(trade);
      }
    }
    target.trades = retained;
  }
  if (Array.isArray(target.orderHistory)) {
    target.orderHistory = target.orderHistory.filter(order => {
      const placed = order?.placedTime == null ? NaN : epoch(order.placedTime);
      const placedRow = Number.isInteger(order?.placedIndex) ? rows[order.placedIndex] : null;
      const after = Number.isFinite(placed) ? placed > cutoff : validCandle(placedRow, BASE) && placedRow[0] + BASE > cutoff;
      if (after) { count += 1; issues.push(`${label}中的订单是在披露截止后才提交，已隐藏。`); return false; }
      redact(order, 'order');
      return true;
    });
  }
  if (target.position) redact(target.position, 'trade');
  if (target.pending) redact(target.pending, 'order');
  if (asOfOpen.length) {
    const active = target.position && Number.isFinite(epoch(target.position.entryTime ?? target.position.entryTimeSec)) &&
      epoch(target.position.entryTime ?? target.position.entryTimeSec) <= cutoff ? target.position : asOfOpen.sort((a,b)=>a.entryTime-b.entryTime).at(-1);
    if (active) target.position = active;
  }
  const positionTime = target.position ? epoch(target.position.entryTime ?? target.position.entryTimeSec) : NaN;
  if (target.position && Number.isFinite(positionTime) && positionTime > cutoff) {
    target.position = null; issues.push(`${label}的当前持仓晚于披露边界，已排除。`); count += 1;
  }
    const pendingTime = target.pending ? epoch(target.pending.placedTime) : NaN;
  if (target.pending && Number.isFinite(pendingTime) && pendingTime > cutoff) {
    target.pending = null; issues.push(`${label}的当前挂单晚于披露边界，已排除。`); count += 1;
  }
  return count;
}

function restrictEvidenceToCutoff(target, cutoff, rows, issues, label) {
  if (!target || typeof target !== 'object' || !Number.isFinite(cutoff)) return;
  const at = item => {
    for (const value of [item?.visibleThrough, item?.replayMarketTime, item?.time, item?.placedTime,
      item?.effectiveFrom?.replayMarketTime]) {
      if (value === null || value === undefined || typeof value === 'string' && !value.trim()) continue;
      const parsed = typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) / 1000 : Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    if (Number.isInteger(item?.index) && validCandle(rows[item.index], BASE)) return rows[item.index][0] + BASE;
    if (Number.isInteger(item?.placedIndex) && validCandle(rows[item.placedIndex], BASE)) return rows[item.placedIndex][0] + BASE;
    return null;
  };
  const collections = ['modelConfigs', 'orders', 'fills', 'ledger', 'accountSnapshots', 'riskChanges',
    'reviewPlans', 'planHistory', 'theses', 'observations', 'drawingVersions', 'snapshots', 'viewSnapshots'];
  for (const key of collections) {
    if (!Array.isArray(target[key])) continue;
    const before = target[key].length;
    target[key] = target[key].filter(item => {
      const time = at(item);
      if (time === null) return true; // Retain legacy evidence but mark it unverifiable below.
      return time <= cutoff;
    });
    if (target[key].length !== before) issues.push(`${label}的${key}中晚于本轮披露边界的 ${before - target[key].length} 条已排除。`);
    if (target[key].some(item => at(item) === null)) issues.push(`${label}的${key}有记录缺少可核验的市场时间或记录时间，原样保留并标明未知。`);
  }
  const visibleConfigIds = new Set((target.modelConfigs || []).map(item => item.modelConfigId).filter(Boolean));
  if (target.modelConfigId && target.modelConfigs && !visibleConfigIds.has(target.modelConfigId))
    target.modelConfigId = (target.modelConfigs.filter(item => !item.baselineOnly).at(-1) ?? target.modelConfigs.at(-1))?.modelConfigId ?? null;
}

function safeCurrentBar(target, cutoff, contextCandles, minuteCandles, issues, label) {
  if (!target || typeof target !== 'object' || !target.currentBar) return;
  const bar = target.currentBar;
  const interval = Number.isInteger(bar.interval) && bar.interval >= BASE ? bar.interval : null;
  if (!interval || !Number.isInteger(bar.time) || bar.time < 0 || bar.time % interval !== 0 || !Number.isFinite(cutoff)) {
    delete target.currentBar;
    issues.push(`${label}的图表当前K线缺少可验证的周期、时间或截止，已排除。`);
    return;
  }
  const contextRows = rowsBetween(contextCandles, bar.time, bar.time + interval).filter(row => row[0] + BASE <= cutoff);
  const minuteRows = rowsBetween(minuteCandles, bar.time, bar.time + interval).filter(row => row[0] + MINUTE <= cutoff);
  const minuteBuckets = new Set(minuteRows.map(row => Math.floor(row[0] / BASE) * BASE));
  const rows = [];
  for (const row of contextRows) if (!minuteBuckets.has(row[0])) rows.push(row);
  rows.push(...minuteRows);
  rows.sort((a, b) => a[0] - b[0]);
  const expected = rows.length ? [rows[0][1], Math.max(...rows.map(row => row[2])),
    Math.min(...rows.map(row => row[3])), rows.at(-1)[4], rows.reduce((sum, row) => sum + row[5], 0)] : null;
  const actual = [bar.open, bar.high, bar.low, bar.close, bar.volume];
  const agrees = expected && actual.every((value, index) => Number.isFinite(value) &&
    Math.abs(value - expected[index]) <= 1e-9 * Math.max(1, Math.abs(expected[index])));
  if (!agrees) {
    delete target.currentBar;
    issues.push(`${label}的图表当前K线无法由该时点已揭示OHLCV核实，已排除。`);
    return;
  }
  target.currentBar = {...bar, complete: bar.time + interval <= cutoff};
}

function rowsBetween(rows, from, to) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle][0] < from) low = middle + 1;
    else high = middle;
  }
  const out = [];
  for (let i = low; i < rows.length && rows[i][0] < to; i += 1) out.push(rows[i]);
  return out;
}

function upperBoundClose(rows, cutoff, interval) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle][0] + interval <= cutoff) low = middle + 1;
    else high = middle;
  }
  return low;
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('导出已取消。');
    error.name = 'AbortError';
    throw error;
  }
}

async function auditEvents(audit, snapshotAt, snapshot, issues, roundCutoff, maxSeq = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(audit?.events)) return {events: [], futureExcluded: 0, recordedAfterSnapshot: 0, afterWatermark: 0};
  const highWatermark = Number.isInteger(audit.eventHighWatermark) ? audit.eventHighWatermark
    : Number.isInteger(snapshot?.eventSeq) ? snapshot.eventSeq : null;
  let beyondSnapshot = 0;
  let recordedAfterSnapshot = 0;
  let afterWatermark = 0;
  const events = audit.events.filter(event => {
    if (!event || typeof event !== 'object') return false;
    if (Number.isFinite(Date.parse(event.recordedAt)) && Date.parse(event.recordedAt) > snapshotAt) { recordedAfterSnapshot += 1; return false; }
    const limit = Math.min(maxSeq, highWatermark ?? Number.MAX_SAFE_INTEGER);
    if (Number.isInteger(event.seq) && event.seq > limit) { afterWatermark += 1; return false; }
    const own = typeof event.visibleThrough === 'string' ? Date.parse(event.visibleThrough) / 1000 : event.visibleThrough;
    const view = typeof event.view?.visibleThrough === 'string' ? Date.parse(event.view.visibleThrough) / 1000 : event.view?.visibleThrough;
    if ([own, view].some(time => Number.isFinite(time) && time > roundCutoff)) { beyondSnapshot += 1; return false; }
    return true;
  }).map(event => stableEventCopy(event, roundCutoff, issues));
  if (beyondSnapshot) issues.push(`冻结快照后或超出行情截止的 ${beyondSnapshot} 条审计事件及其截图未纳入。`);
  return {events, futureExcluded: beyondSnapshot, recordedAfterSnapshot, afterWatermark};
}

function createZip(files) {
  let total = 0;
  const locals = [], centrals = [];
  for (const file of files) {
    const name = utf8.encode(file.name);
    const bytes = file.bytes;
    if (bytes.length > ZIP_LIMIT || name.length > 0xffff) throw new Error(`ZIP 文件过大或文件名过长：${file.name}`);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length + bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30); local.set(bytes, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, total, true); central.set(name, 46);
    locals.push(local); centrals.push(central); total += local.length;
    if (total > ZIP_LIMIT) throw new Error('复盘包超过 ZIP32 单文件上限，未截断数据。');
  }
  const centralBytes = centrals.reduce((sum, bytes) => sum + bytes.length, 0);
  if (files.length > 0xffff || total + centralBytes > ZIP_LIMIT) throw new Error('复盘包超出 ZIP32 容量限制，未截断数据。');
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralBytes, true); ev.setUint32(16, total, true);
  return new Blob([...locals, ...centrals, end], {type: 'application/zip'});
}

async function bytesOf(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('截图数据不是可读取的 Blob 或二进制缓冲区。');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function tradeAnchor(trade, index, used) {
  const id = trade?.id ?? trade?.orderId ?? `legacy-${index + 1}`;
  const slug = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || `legacy-${index + 1}`;
  let anchor = `trade-${slug}`, suffix = 2;
  while (used.has(anchor)) {
    const tail = `-${suffix++}`;
    anchor = `trade-${slug.slice(0, 60 - tail.length)}${tail}`;
  }
  used.add(anchor);
  return {id: String(id), anchor};
}

function eventMatchesTrade(event, trade) {
  const tradeId = trade?.id == null ? null : String(trade.id);
  const orderId = trade?.orderId == null ? null : String(trade.orderId);
  const eventTradeId = event?.tradeId == null ? null : String(event.tradeId);
  const eventOrderId = event?.orderId == null ? null : String(event.orderId);
  if (eventTradeId || eventOrderId) return [eventTradeId, eventOrderId].some(id => id && (id === tradeId || id === orderId));
  const matchesActive = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const identifiers = [value.tradeId, value.orderId];
    const looksLikeTrade = Object.hasOwn(value, 'exitTime') || Object.hasOwn(value, 'pnl');
    const looksLikeOrder = Object.hasOwn(value, 'entryPrice') || Object.hasOwn(value, 'notional') || Object.hasOwn(value, 'status');
    if (value.id != null && ((looksLikeTrade && tradeId && String(value.id) === tradeId) ||
        (looksLikeOrder && orderId && String(value.id) === orderId))) identifiers.push(value.id);
    return identifiers.some(id => id != null && (String(id) === tradeId || String(id) === orderId));
  };
  for (const state of [event?.before, event?.after]) {
    if (!state || typeof state !== 'object') continue;
    for (const key of ['pending', 'position', 'trade', 'order', 'fill']) if (matchesActive(state[key])) return true;
    if (matchesActive(state)) return true;
  }
  return false;
}

function stageName(event) {
  const kind = String(event?.kind ?? '');
  if (/position-(?:closed|auto-closed)|trade|liquidat|exit|order-cancelled/.test(kind)) return '出场 / 退出';
  if (/protection|modified|drawing-modified/.test(kind)) return '保护线 / 订单修改';
  if (/order-submitted|order-filled|position-opened|fill/.test(kind)) return '开仓 / 入场';
  return '相关操作';
}

function renderReviewBook(sessions) {
  const sections = [];
  for (const sessionRecord of sessions) {
    const session = sessionRecord.session ?? {};
    const trades = Array.isArray(session.trades) ? session.trades : [];
    const events = (Array.isArray(sessionRecord.events) ? sessionRecord.events : []).map((event, index) => ({event, index}))
      .sort((a, b) => {
        const aSeq = Number.isInteger(a.event?.seq) ? a.event.seq : Number.MAX_SAFE_INTEGER;
        const bSeq = Number.isInteger(b.event?.seq) ? b.event.seq : Number.MAX_SAFE_INTEGER;
        if (aSeq !== bSeq) return aSeq - bSeq;
        const aTime = Date.parse(a.event?.recordedAt) || 0;
        const bTime = Date.parse(b.event?.recordedAt) || 0;
        return aTime - bTime || a.index - b.index;
      }).map(item => item.event);
    const screenshots = Array.isArray(sessionRecord.auditScreenshots) ? sessionRecord.auditScreenshots : [];
    const screenshotByEvent = new Map();
    for (const image of screenshots) {
      if (!screenshotByEvent.has(String(image.eventId))) screenshotByEvent.set(String(image.eventId), []);
      screenshotByEvent.get(String(image.eventId)).push(image);
    }
    const usedAnchors = new Set();
    const reviewTrades = trades.map((trade, index) => {
      const {id, anchor} = tradeAnchor(trade, index, usedAnchors);
      return {trade, id, anchor, orderId: trade?.orderId == null ? null : String(trade.orderId), stages: []};
    });
    const eventOwners = new Map(events.map((event, index) => [`${String(event.id)}\u0000${index}`, []]));
    for (const [index, event] of events.entries()) {
      for (const tradeEntry of reviewTrades) if (eventMatchesTrade(event, tradeEntry.trade)) eventOwners.get(`${String(event.id)}\u0000${index}`).push(tradeEntry);
    }
    const assignedEventIds = new Set();
    const usedScreenshotPaths = new Set();
    for (const [eventIndex, event] of events.entries()) {
      const owners = eventOwners.get(`${String(event.id)}\u0000${eventIndex}`) ?? [];
      if (owners.length !== 1) continue;
      const owner = owners[0];
      const images = screenshotByEvent.get(String(event.id)) ?? [];
      const stage = {kind: stageName(event), eventId: event.id, eventKind: event.kind,
        seq: Number.isInteger(event.seq) ? event.seq : null, recordedAt: event.recordedAt ?? null,
        visibleThrough: event.visibleThrough ?? null, orderId: event.orderId ?? null, tradeId: event.tradeId ?? null,
        screenshotPaths: images.map(image => image.path)};
      owner.stages.push(stage); assignedEventIds.add(String(event.id));
      for (const image of images) usedScreenshotPaths.add(image.path);
    }
    for (const tradeEntry of reviewTrades) {
      tradeEntry.stages.sort((a, b) => {
        const aSeq = Number.isInteger(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
        const bSeq = Number.isInteger(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
        if (aSeq !== bSeq) return aSeq - bSeq;
        const aTime = Date.parse(a.recordedAt) || 0;
        const bTime = Date.parse(b.recordedAt) || 0;
        return aTime - bTime;
      });
    }
    const reviewBookMeta = {htmlPath: '复盘册.html', trades: reviewTrades.map(({trade, id, anchor, orderId, stages}) => ({
      tradeId: trade?.id == null ? null : String(trade.id), id, orderId, anchor, stages
    }))};
    sessionRecord.reviewBook = reviewBookMeta;
    session.reviewBook = reviewBookMeta;
    const transactionSections = reviewTrades.map(({trade, id, anchor, stages}, index) => {
      const fmt = value => Number.isFinite(value) ? htmlEscape(value) : '未记录';
      const stagesHtml = stages.length ? stages.map(stage => {
        const images = stage.screenshotPaths.map(path => `<figure><a href="${htmlEscape(path)}"><img loading="lazy" src="${htmlEscape(path)}" alt="${htmlEscape(stage.kind)}截图"></a><figcaption>${htmlEscape(stage.kind)} · ${htmlEscape(stage.eventKind)}</figcaption></figure>`).join('');
        return `<li><strong>${htmlEscape(stage.kind)}</strong><span>${htmlEscape(stage.eventKind)} · ${htmlEscape(iso(stage.visibleThrough) ?? '时间未记录')}</span>${images || '<p class="missing">此阶段没有可关联的关键截图。</p>'}</li>`;
      }).join('') : '<li class="missing">旧记录没有可确认关联的开仓、改单或退出事件；不根据时间相近猜测截图。</li>';
      return `<article id="${htmlEscape(anchor)}"><h3>交易 ${index + 1} · ${htmlEscape(trade.side === 1 ? '做多' : trade.side === -1 ? '做空' : '方向未记录')}</h3><p>编号 ${htmlEscape(id)} · 订单 ${htmlEscape(trade.orderId ?? '未记录')}</p><dl><dt>入场时间 / 价格</dt><dd>${htmlEscape(iso(trade.entryTime) ?? trade.entryTime ?? '未记录')} / ${fmt(trade.entry)}</dd><dt>出场时间 / 价格</dt><dd>${htmlEscape(iso(trade.exitTime) ?? trade.exitTime ?? '未记录')} / ${fmt(trade.exit)}</dd><dt>数量 / 净盈亏</dt><dd>${fmt(trade.qty)} ${session.symbol?.startsWith('ETH') ? 'ETH' : 'BTC'} / ${fmt(trade.pnl)} USDT</dd><dt>入场理由</dt><dd class="user-text">${htmlEscape(trade.entryReason ?? '未记录')}</dd><dt>退出方式 / 理由</dt><dd>${htmlEscape(trade.reason ?? '未记录')} · ${htmlEscape(trade.exitReason ?? '未记录')}</dd></dl><h4>阶段截图与操作</h4><ol>${stagesHtml}</ol></article>`;
    }).join('');
    const unassigned = events.filter(event => !assignedEventIds.has(String(event.id)));
    const unmatched = screenshots.filter(image => !usedScreenshotPaths.has(image.path));
    const otherImages = unmatched.map(image => `<figure><a href="${htmlEscape(image.path)}"><img loading="lazy" src="${htmlEscape(image.path)}" alt="未匹配截图"></a><figcaption>未能无歧义关联到某笔交易 · 事件 ${htmlEscape(image.eventId)}</figcaption></figure>`).join('');
    const tradeBody = transactionSections || '<p>本轮没有已平仓交易。</p>';
    const oldScreenshotLayerWarning = screenshots.some(image => {
      const event = events.find(item => item?.id === image?.eventId);
      return event && !event?.references?.screenshotBindingVersion;
    }) ? '<p class="missing">旧版截图可能混入上一笔交易卡片；图中的价格、保护价或盈亏不能单独证明当前交易状态，应以同一事件的结构化记录为准。原始截图未改写。</p>' : '';
    sections.push(`<section><h2>${htmlEscape(sessionRecord.id ?? session.id ?? '未命名练习')} · ${htmlEscape(session.symbol ?? '品种未记录')}</h2><p>可见行情截止 ${htmlEscape(sessionRecord.coverage?.visibleThroughUtc ?? '未记录')} UTC；行情 ${sessionRecord.coverage?.marketComplete ? '完整' : '不完整'}；过程记录 ${sessionRecord.coverage?.auditComplete ? '完整' : '不完整或未录全'}；关键截图 ${sessionRecord.coverage?.screenshotsComplete ? '齐全' : '有缺失'}；行情缺口 ${sessionRecord.coverage?.gaps?.length ?? 0} 项。</p>${oldScreenshotLayerWarning}${tradeBody}<h3>未归属到交易的操作和截图</h3>${unassigned.length ? `<p>保留 ${unassigned.length} 条未能与单笔成交无歧义关联的事件。</p>` : '<p>无。</p>'}${otherImages || '<p>没有未归属截图。</p>'}</section>`);
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>K线回放离线复盘册</title><style>body{margin:0;background:#10161b;color:#d9e1e7;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1000px;margin:auto;padding:28px}h1,h2,h3,h4{color:#e8f0f5}section,article{border:1px solid #34424c;border-radius:10px;padding:18px;margin:18px 0;background:#172127}article{background:#121b20;scroll-margin-top:12px}dl{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:5px 14px}dt{color:#8da1ab}dd{margin:0;overflow-wrap:anywhere}.user-text{white-space:pre-wrap}.missing{color:#d8aa72}li{margin:12px 0}li span{display:block;color:#aebbc2;font-size:13px}figure{display:inline-block;vertical-align:top;margin:10px 10px 4px 0;max-width:min(100%,720px)}img{display:block;max-width:100%;height:auto;border:1px solid #41515b;border-radius:5px}figcaption{color:#aebbc2;font-size:12px;margin-top:4px}a{color:#83baff}code{color:#b4d7ff}@media(max-width:600px){main{padding:14px}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}</style><main><h1>K线回放离线复盘册</h1><p>本页来自导出时冻结的本地交易记录与关键操作截图。截图只在事件和订单/成交编号可明确匹配时归入对应阶段；无明确关联的内容单列，不按时间猜测。</p><p>所有路径均相对于本HTML文件，可离线查看。真实行情、完整记录、逐笔分析见同目录文件。</p>${sections.join('\n')}</main></html>`;
  return html;
}

/** Create a self-contained ZIP without mutating the live practice state. */
export async function buildReviewExport({current = null, history = [], loadDataset, readAudit,
  onProgress = () => {}, signal, exportSnapshotAt, auditWatermarks = {}} = {}) {
  if (typeof loadDataset !== 'function' || typeof readAudit !== 'function') throw new TypeError('复盘导出需要行情读取和练习记录读取接口。');
  const exportedAt = new Date().toISOString();
  const snapshotAt = Number.isFinite(exportSnapshotAt) ? exportSnapshotAt
    : typeof exportSnapshotAt === 'string' && Number.isFinite(Date.parse(exportSnapshotAt)) ? Date.parse(exportSnapshotAt) : Date.now();
  const rounds = collectRoundInputs(current, Array.isArray(history) ? history : []);
  const snapshot = {current: current ? clone(current) : null,
    history: Array.isArray(history) ? clone(history) : [], exportedAt, snapshotAt: new Date(snapshotAt).toISOString()};
  // Raw practice objects are copied for compatibility, but a forming candle is
  // market data and must be revalidated against the corresponding frozen minute
  // prefix before being retained anywhere in the archive.
  const legacyRedactions = [];
  if (snapshot.current && stripFormingDeep(snapshot.current)) legacyRedactions.push({slot: 'current', field: 'forming15m', reason: '保留字段位置及脱敏原因，不保留可能泄露未来的完整K线。'});
  for (let index = 0; index < snapshot.history.length; index += 1) {
    const item = snapshot.history[index];
    if (item && stripFormingDeep(item)) legacyRedactions.push({slot: `history-${index}`, field: 'forming15m', reason: '保留字段位置及脱敏原因，不保留可能泄露未来的完整K线。'});
  }
  const legacyBackupState = {current: clone(snapshot.current), history: clone(snapshot.history)};
  const issues = [];
  const datasets = new Map();
  const dayCache = new Map();
  const sessions = [];
  const screenshotFiles = [];
  let workDone = 0;
  const total = rounds.length;
  const reportProgress = detail => { try { onProgress({completed: workDone, total, ...detail}); } catch {} };

  for (const input of rounds) {
    checkAbort(signal);
    const roundIssues = [];
    if (!input.session) {
      sessions.push({id: input.id, slot: input.slot, session: null, coverage: {captureCoverageComplete: false,
        evidenceComplete: false, evidenceCoverage: {status: 'unknown-legacy', reason: '无法读取session快照'}}, market: null,
        events: [], issues: ['此历史记录缺少可读取的session快照，原记录保留在顶层history。'], rawInvalidRecord: input.rawInvalidRecord});
      workDone += 1; reportProgress({sessionId: input.id, phase: 'record'}); continue;
    }
    let record = input.session;
    let audit = {};
    let auditReadSucceeded = true;
    try {
      const roundId = String(input.id ?? record.id ?? '');
      const maxSeq = Number.isInteger(auditWatermarks?.[roundId]) ? auditWatermarks[roundId] : Number.MAX_SAFE_INTEGER;
      const roughCutoff = Number.isInteger(record.minuteCursorTime) ? record.minuteCursorTime + MINUTE : null;
      audit = await readAudit(input.id ?? record.id, {snapshotAt: new Date(snapshotAt).toISOString(),
        visibleThrough: roughCutoff, maxSeq, sessionSnapshot: record});
      if (!audit || typeof audit !== 'object') audit = {};
      if (input.imported && audit.archivedSession && typeof audit.archivedSession === 'object') record = audit.archivedSession;
    } catch (error) {
      auditReadSucceeded = false;
      roundIssues.push(`无法读取本轮操作审计：${error?.message || '未知错误'}`);
    }
    const symbol = record.symbol;
    if (!SYMBOLS.has(symbol)) {
      const safeRecord = clone(record); stripFormingDeep(safeRecord);
      sessions.push({id: input.id, slot: input.slot, session: safeRecord, archivedAt: input.archivedAt,
        coverage: {complete: false}, market: null, events: [], issues: [`不支持的或缺失的行情品种：${String(symbol)}`, '行情截止不可验证，未包含快照中的未完成15分钟行情。']});
      workDone += 1; reportProgress({sessionId: input.id, phase: 'record'}); continue;
    }
    let sourceDataset;
    try {
      const importedMarket = input.imported ? audit.sourceMetadata?.market : null;
      if (Array.isArray(importedMarket?.contextCandles) && importedMarket.contextCandles.length) {
        const coverage = audit.coverage ?? audit.sourceMetadata?.coverage ?? {};
        sourceDataset = normalizeDataset({symbol, interval: BASE, candles: importedMarket.contextCandles,
          range: {start: Number.isFinite(coverage.visibleFrom) ? coverage.visibleFrom : importedMarket.contextCandles[0][0],
            end: Number.isFinite(coverage.visibleThrough) ? coverage.visibleThrough : importedMarket.contextCandles.at(-1)[0] + BASE},
          sources: importedMarket.sources ?? [], sourceManifest: importedMarket.sourceManifest ?? null}, symbol, roundIssues);
      } else {
        if (!datasets.has(symbol)) datasets.set(symbol, normalizeDataset(await loadDataset(symbol), symbol, roundIssues));
        sourceDataset = datasets.get(symbol);
      }
    } catch (error) {
      roundIssues.push(`无法读取内置15分钟行情：${error?.message || '未知错误'}`);
      const safeRecord = clone(record); stripFormingDeep(safeRecord);
      roundIssues.push('行情截止不可验证，未包含快照中的未完成15分钟行情。');
      sessions.push({id: input.id, slot: input.slot, session: safeRecord, archivedAt: input.archivedAt,
        coverage: {complete: false}, market: null, events: [], issues: roundIssues});
      workDone += 1; reportProgress({sessionId: input.id, phase: 'dataset-error'}); continue;
    }
    const {rows, source, range} = sourceDataset;
    const cutoff = sessionCutoff(record, rows);
    const bounds = startBounds(record, rows, range);
    if (!Number.isFinite(cutoff) || !Number.isFinite(bounds.visibleFrom) || !Number.isFinite(bounds.replayFrom)) {
      roundIssues.push('快照时间或历史观察范围无法从记录定位；未猜测数据截止。');
      const safeRecord = clone(record); stripFormingDeep(safeRecord);
      sessions.push({id: input.id, slot: input.slot, session: safeRecord, archivedAt: input.archivedAt,
        coverage: {complete: false}, market: null, events: [], issues: roundIssues});
      workDone += 1; reportProgress({sessionId: input.id, phase: 'snapshot-error'}); continue;
    }
    const roundCutoff = Math.min(cutoff, Number.isFinite(range?.end) ? range.end : cutoff);
    const contextCandles = rows.filter(row => row[0] >= bounds.visibleFrom && row[0] + BASE <= roundCutoff);
    const contextGaps = findGaps(contextCandles, BASE, 'official_15m_gap');
    if (bounds.warmupMissingBars > 0) contextGaps.unshift({type: 'context_warmup_unavailable', from: bounds.requestedVisibleFrom,
      to: bounds.availableStart - BASE, missingBars: bounds.warmupMissingBars,
      fromUtc: iso(bounds.requestedVisibleFrom), toUtc: iso(bounds.availableStart - BASE)});
    const expectedFrom = Math.ceil(bounds.replayFrom / MINUTE) * MINUTE;
    const expectedThrough = Math.floor((roundCutoff - MINUTE) / MINUTE) * MINUTE;
    // Import only valid audit minutes up to the frozen cutoff.
    const minuteByTime = new Map();
    let invalidAuditMinutes = 0;
    let futureAuditMinutesFiltered = 0;
    const minuteSourceRows = [
      ...(Array.isArray(audit.minutes) ? audit.minutes : []),
      ...(Array.isArray(audit.sourceMetadata?.market?.minuteCandles) ? audit.sourceMetadata.market.minuteCandles : []),
    ];
    for (const row of minuteSourceRows) {
      if (validCandle(row, MINUTE) && (row[0] < expectedFrom || row[0] > expectedThrough || row[0] + MINUTE > roundCutoff)) {
        futureAuditMinutesFiltered += row[0] > expectedThrough || row[0] + MINUTE > roundCutoff ? 1 : 0;
      }
      if (!validCandle(row, MINUTE) || row[0] < expectedFrom || row[0] > expectedThrough || row[0] + MINUTE > roundCutoff) {
        invalidAuditMinutes += 1; continue;
      }
      minuteByTime.set(row[0], row.slice(0, 6));
    }
    if (invalidAuditMinutes) roundIssues.push(`已隔离 ${invalidAuditMinutes} 条超出本轮可见范围或格式无效的录制分钟行。`);

    const expectedTimes = [];
    for (let time = expectedFrom; time <= expectedThrough; time += MINUTE) expectedTimes.push(time);
    const missingTimes = expectedTimes.filter(time => !minuteByTime.has(time));
    const requestedDays = new Set(missingTimes.map(utcDay));
    const verifiedDays = new Set();
    const unavailable = [];
    for (const day of requestedDays) {
      checkAbort(signal);
      const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
      const dayEnd = dayStart + 86400;
      const from = Math.max(bounds.replayFrom, dayStart);
      const through = Math.min(roundCutoff, dayEnd);
      if (through <= from) continue;
      try {
        if (input.imported) {
          unavailable.push({from, through, reason: '导入档案只使用其本地已保存的行情证据；未联网补取。'});
          roundIssues.push(`导入档案缺少 ${utcDay(from)} 至 ${utcDay(through)} 的分钟行情；离线再导出不联网补取。`);
          continue;
        }
        const result = await readMinuteRange(symbol, from, through, {dayCache, signal});
        const dayEntry = result.days.find(entry => entry.date === day);
        if (dayEntry && !dayEntry.unavailable) verifiedDays.add(day);
        else if (dayEntry?.unavailable) unavailable.push(...result.unavailable.filter(entry => entry.date === day));
        for (const row of result.candles) {
          const previous = minuteByTime.get(row[0]);
          if (previous && previous.some((value, index) => value !== row[index])) {
            roundIssues.push(`录制分钟与Binance归档在 ${iso(row[0])} 不一致，已采用校验后的归档行。`);
          }
          minuteByTime.set(row[0], row.slice(0, 6));
        }
        roundIssues.push(...result.unavailable.filter(entry => entry.date === day).map(entry => `${entry.date} 分钟归档无法读取：${entry.reason}`));
      } catch (error) {
        unavailable.push({symbol, date: day, reason: error?.message || '无法读取分钟数据。'});
        roundIssues.push(`${day} 分钟归档无法读取：${error?.message || '未知错误'}`);
      }
      reportProgress({sessionId: input.id, phase: 'minutes', date: day, rows: minuteByTime.size});
    }
    const minuteCandles = expectedTimes.filter(time => minuteByTime.has(time)).map(time => minuteByTime.get(time));
    const partialIndex = buildPartialIndex(minuteCandles);
    const missingFinal = expectedTimes.filter(time => !minuteByTime.has(time));
    const typeByTime = new Map();
    for (const time of missingFinal) typeByTime.set(time, verifiedDays.has(utcDay(time)) ? 'official_1m_gap' : 'minute_archive_unavailable');
    const minuteGaps = coalesceTimes(missingFinal, MINUTE, typeByTime);
    if (minuteGaps.length) roundIssues.push(`回放分钟序列存在 ${missingFinal.length} 根缺失（含公开归档缺口或不可读取日），详见coverage.gaps。`);

    const allSource15m = Array.isArray(source.sources) ? source.sources : [];
    const safe15mSources = allSource15m.filter(entry => {
      const month = monthKey(entry.url);
      if (!month) return false;
      const [year, mon] = month.split('-').map(Number);
      const monthEnd = Date.UTC(year, mon, 1) / 1000;
      return monthEnd <= roundCutoff;
    });
    const contextSha = await digestRows(contextCandles);
    const minuteSha = await digestRows(minuteCandles);
    const minuteSources = [];
    for (const day of [...new Set(minuteCandles.map(row => utcDay(row[0])))]) {
      const dayInfo = dayCache.get(`${symbol}/${day}`);
      const fullUtcDayVisible = roundCutoff >= Date.parse(`${nextDay(day)}T00:00:00Z`) / 1000;
      if (dayInfo?.source && fullUtcDayVisible) minuteSources.push({date: day, ...dayInfo.source});
      else minuteSources.push({date: day, sliceSha256: await digestRows(minuteCandles.filter(row => utcDay(row[0]) === day)),
        note: '仅列出已揭示分钟切片的哈希；未公开含未来行的整日归档哈希或URL。'});
    }
    const roundId = String(input.id ?? record.id ?? '');
    const maxSeq = Number.isInteger(auditWatermarks?.[roundId]) ? auditWatermarks[roundId] : Number.MAX_SAFE_INTEGER;
    const audited = await auditEvents(audit, snapshotAt, record, roundIssues, roundCutoff, maxSeq);
    const currentEvents = audited.events;
    const auditScreens = Array.isArray(audit.screenshots) ? audit.screenshots : [];
    const screenshotMeta = [];
    const includedEventIds = new Set(currentEvents.map(event => event.id).filter(id => id != null));
    for (const image of auditScreens) {
      if (!image || image.eventId == null || !includedEventIds.has(image.eventId) || !image.blob) continue;
      try {
        const bytes = await bytesOf(image.blob);
        const mime = typeof image.mimeType === 'string' ? image.mimeType : image.blob.type || 'image/png';
        const extension = /jpe?g/i.test(mime) ? 'jpg' : /webp/i.test(mime) ? 'webp' : /png/i.test(mime) ? 'png' : null;
        if (!extension) throw new Error(`不支持的截图格式 ${mime}`);
        const path = `截图/${safeId(input.slot, 'session')}_${safeId(input.id ?? record.id, 'session')}_${safeId(image.id, 'image')}.${extension}`;
        const hash = await sha256(bytes);
        screenshotFiles.push({name: path, bytes});
        screenshotMeta.push({id: image.id, eventId: image.eventId, mimeType: mime,
          captureType: typeof image.captureType === 'string' ? image.captureType : 'unknown-legacy',
          path, bytes: bytes.length, sha256: hash});
      } catch (error) { roundIssues.push(`截图 ${image?.id ?? '未知'} 未能打包：${error?.message || '数据不可读'}`); }
    }
    const screenshotByEventId = new Map();
    for (const image of screenshotMeta) {
      const key = String(image.eventId);
      if (!screenshotByEventId.has(key)) screenshotByEventId.set(key, []);
      screenshotByEventId.get(key).push(image);
    }
    const expectedScreenshotActions = currentEvents.filter(event => SCREENSHOT_ACTIONS.has(String(event.kind)));
    const missingScreenshotEventIds = expectedScreenshotActions.filter(event => !(screenshotByEventId.get(String(event.id)) || [])
      .some(image => !event.screenshotId || String(image.id) === String(event.screenshotId))).map(event => event.id ?? event.seq ?? null);
    for (const id of missingScreenshotEventIds) roundIssues.push(`关键操作事件 ${id ?? '未知'} 没有可验证的截图附件。`);
    const sessionForPackage = clone(record);
    const futureOutcomeRedactions = redactFutureOutcomes(sessionForPackage, roundCutoff, rows, roundIssues, '本轮快照');
    restrictEvidenceToCutoff(sessionForPackage, roundCutoff, rows, roundIssues, '本轮快照');
    redactUnverifiedPartial(sessionForPackage, roundCutoff, partialIndex, roundIssues, '本轮快照');
    safeCurrentBar(sessionForPackage, roundCutoff, contextCandles, minuteCandles, roundIssues, '本轮快照');
    if (Array.isArray(sessionForPackage.trades)) {
      for (const trade of sessionForPackage.trades) {
        const exit = Number.isFinite(trade?.exitTime) ? trade.exitTime :
          typeof trade?.exitTime === 'string' && Number.isFinite(Date.parse(trade.exitTime)) ? Date.parse(trade.exitTime) / 1000 : null;
        if (exit !== null && roundCutoff !== null && exit <= roundCutoff)
          trade.followUpWindows = postExitWindows(trade, minuteCandles, roundCutoff);
      }
    }
    if (input.slot === 'current') {
      snapshot.current = clone(sessionForPackage);
      legacyBackupState.current = clone(sessionForPackage);
    }
    else {
      const historyIndex = Number(input.slot.slice('history-'.length));
      if (Number.isInteger(historyIndex) && snapshot.history[historyIndex]?.session) {
        snapshot.history[historyIndex].session = clone(sessionForPackage);
        if (legacyBackupState.history[historyIndex]?.session) legacyBackupState.history[historyIndex].session = clone(sessionForPackage);
      }
    }
    let eventOutcomeRedactions = 0;
    const sessionEvents = currentEvents.map(event => {
      const eventCutoff = Number.isFinite(event.visibleThrough) ? Math.min(event.visibleThrough, roundCutoff) : null;
      if (Number.isFinite(event.visibleThrough) && event.visibleThrough > roundCutoff) {
        roundIssues.push(`事件 ${event.id ?? event.seq ?? '未知'} 晚于冻结练习截止，已限制事件可见范围。`);
      }
      const minuteCount = eventCutoff == null ? 0 : upperBoundClose(minuteCandles, eventCutoff, MINUTE);
      const contextCount = eventCutoff == null ? 0 : upperBoundClose(contextCandles, eventCutoff, BASE);
      const safeEvent = clone(event);
      if (eventCutoff !== null) {
        const beforeCutoff = Number.isFinite(safeEvent.before?.minuteCursorTime) ? safeEvent.before.minuteCursorTime + MINUTE
          : sessionCutoff(safeEvent.before, rows);
        const afterCutoff = Number.isFinite(safeEvent.after?.minuteCursorTime) ? safeEvent.after.minuteCursorTime + MINUTE
          : sessionCutoff(safeEvent.after, rows);
        redactUnverifiedPartial(safeEvent.before, Math.min(beforeCutoff ?? eventCutoff, eventCutoff), partialIndex, roundIssues,
          `事件${event.seq ?? event.id ?? ''}操作前`);
        redactUnverifiedPartial(safeEvent.after, Math.min(afterCutoff ?? eventCutoff, eventCutoff), partialIndex, roundIssues,
          `事件${event.seq ?? event.id ?? ''}操作后`);
        eventOutcomeRedactions += redactFutureOutcomes(safeEvent.before, Math.min(beforeCutoff ?? eventCutoff, eventCutoff), rows, roundIssues,
          `事件${event.seq ?? event.id ?? ''}操作前`);
        eventOutcomeRedactions += redactFutureOutcomes(safeEvent.after, Math.min(afterCutoff ?? eventCutoff, eventCutoff), rows, roundIssues,
          `事件${event.seq ?? event.id ?? ''}操作后`);
        safeCurrentBar(safeEvent.before, Math.min(beforeCutoff ?? eventCutoff, eventCutoff), contextCandles, minuteCandles,
          roundIssues, `事件${event.seq ?? event.id ?? ''}操作前图表K线`);
        safeCurrentBar(safeEvent.after, Math.min(afterCutoff ?? eventCutoff, eventCutoff), contextCandles, minuteCandles,
          roundIssues, `事件${event.seq ?? event.id ?? ''}操作后图表K线`);
        redactUnverifiedPartial(safeEvent.view, eventCutoff, partialIndex, roundIssues, `事件${event.seq ?? event.id ?? ''}图表状态`);
        safeCurrentBar(safeEvent.view, eventCutoff, contextCandles, minuteCandles, roundIssues,
          `事件${event.seq ?? event.id ?? ''}图表当前K线`);
      } else {
        redactForming(safeEvent.before, '事件没有可验证的市场截止；完整未完成K线未导出。');
        redactForming(safeEvent.after, '事件没有可验证的市场截止；完整未完成K线未导出。');
        redactForming(safeEvent.view, '事件没有可验证的市场截止；完整未完成K线未导出。');
      }
      return {...safeEvent, visibleThrough: eventCutoff,
        informationSet: eventCutoff == null ? null : {visibleThrough: eventCutoff, visibleThroughUtc: iso(eventCutoff),
          context15mCount: contextCount, minuteCount,
          note: '仅使用相应market数组前缀；不应将事件之后的K线用于该决策快照。'}};
    });
    const auditIssues = Array.isArray(audit.issues) ? audit.issues.filter(value => typeof value === 'string') : [];
    const localIssues = [...roundIssues, ...auditIssues];
    const covered = minuteCandles.length;
    const expected = expectedTimes.length;
    const marketComplete = expected === covered && bounds.warmupMissingBars === 0 && contextGaps.length === 0 && minuteGaps.length === 0 && unavailable.length === 0;
    const auditComplete = auditReadSucceeded && audit.baseline === false && !!audit.recordingStartedAt && auditIssues.length === 0;
    const captureScreenshotsComplete = missingScreenshotEventIds.length === 0;
    const captureBoundaryValue = sessionForPackage.modelEvidenceStart?.visibleThrough ?? sessionForPackage.modelEvidenceStart?.replayMarketTime;
    const captureReplayStart = typeof captureBoundaryValue === 'number' && Number.isFinite(captureBoundaryValue) ? captureBoundaryValue : null;
    const captureTrades = Array.isArray(sessionForPackage.trades) ? sessionForPackage.trades : [];
    const preCaptureTrades = captureReplayStart === null ? null : captureTrades.filter(trade =>
      Number.isFinite(trade.entryTime) && trade.entryTime < captureReplayStart).length;
    const screenshotsComplete = captureScreenshotsComplete && preCaptureTrades === 0;
    const evidenceCoverage = evidenceCoverageFor(sessionForPackage, sessionEvents);
    const modelEvidence = modelEvidenceFor(sessionForPackage);
    const roundPayload = {
      id: input.id ?? record.id ?? input.slot, slot: input.slot, archivedAt: input.archivedAt,
      session: sessionForPackage,
      modelEvidence,
      coverage: {visibleFrom: bounds.visibleFrom, visibleFromUtc: iso(bounds.visibleFrom),
        requestedVisibleFrom: bounds.requestedVisibleFrom, requestedVisibleFromUtc: iso(bounds.requestedVisibleFrom),
        warmupMissingBars: bounds.warmupMissingBars,
        visibleThrough: roundCutoff, visibleThroughUtc: iso(roundCutoff), replayFrom: bounds.replayFrom,
        replayFromUtc: iso(bounds.replayFrom), cutoffIsExclusiveClose: true, expectedMinuteRows: expected,
        availableMinuteRows: covered, missingMinuteRows: expected - covered,
        marketComplete, auditComplete, screenshotsComplete,
        captureCoverageComplete: marketComplete && auditComplete && captureScreenshotsComplete,
        historicalEvidenceComplete: evidenceCoverage.evidenceComplete && screenshotsComplete,
        evidenceCoverage: evidenceCoverage.evidence, evidenceComplete: evidenceCoverage.evidenceComplete,
        baseline: audit.baseline ?? null, auditRecordingStartedAt: audit.recordingStartedAt ?? null,
        screenshotCoverage: {scope: '当前操作审计采集范围；不代表基线之前的全部交易',
          captureReplayStart, captureReplayStartUtc: iso(captureReplayStart),
          expectedKeyActionCount: expectedScreenshotActions.length,
          availableScreenshotCount: expectedScreenshotActions.length - missingScreenshotEventIds.length,
          missingScreenshotCount: missingScreenshotEventIds.length, missingEventIds: missingScreenshotEventIds,
          captureRangeComplete: captureScreenshotsComplete,
          historicalStatus: preCaptureTrades === null ? 'unknown-legacy' : preCaptureTrades ? 'unknown-legacy' : 'not-applicable',
          preCaptureTradesWithoutVerifiableCapture: preCaptureTrades},
        futureFiltered: {minuteRows: futureAuditMinutesFiltered, auditEvents: audited.futureExcluded,
          laterRecordedEvents: audited.recordedAfterSnapshot, beyondEventWatermark: audited.afterWatermark,
          tradeOutcomes: futureOutcomeRedactions + eventOutcomeRedactions,
          forming15mFinalBar: record.forming15m ? 1 : 0, legacyStateFields: legacyRedactions.filter(entry =>
            entry.slot === input.slot).length},
        gaps: [...contextGaps, ...minuteGaps], unavailableDays: unavailable,
        recordingStartedAt: audit.recordingStartedAt ?? null, auditBaseline: audit.baseline ?? null},
      market: {contextInterval: BASE, contextCandles, replayInterval: MINUTE, minuteCandles,
        marketDataUnits: {timestamps: 'Unix秒，UTC', row: ['openTime', 'open', 'high', 'low', 'close', 'volume'],
          prices: 'USDT per BTC/ETH', volume: symbol === 'BTCUSDT' ? 'BTC基础资产数量，不是USDT成交额' : 'ETH基础资产数量，不是USDT成交额'},
        forming: sessionForPackage.forming15m ? {time: sessionForPackage.forming15m[0], disclosedPartial: true,
          candle: sessionForPackage.forming15m.slice(0, 6), note: '仅由截止时已揭示分钟形成；禁止替换成原始15分钟最终OHLCV。'} : null,
        sources: [{name: 'Binance Vision 官方现货归档', source: '按已揭示时间裁剪；禁止使用未回放行情'}],
        sourceManifest: {provider: 'Binance Vision 现货公开归档', sourceIndex: safe15mSources,
          contextSliceSha256: contextSha, minuteDays: minuteSources, minuteSliceSha256: minuteSha}},
      events: sessionEvents, auditScreenshots: screenshotMeta, issues: localIssues,
    };
    sessions.push(roundPayload);
    issues.push(...localIssues.map(message => ({sessionId: roundPayload.id, message})));
    workDone += 1;
    reportProgress({sessionId: roundPayload.id, phase: 'complete', minuteRows: covered, expectedMinuteRows: expected});
  }

  const safeSessionById = new Map(sessions.filter(item => item?.id != null && item?.session)
    .map(item => [String(item.id), item.session]));
  if (snapshot.current?.id != null && safeSessionById.has(String(snapshot.current.id)))
    snapshot.current = clone(safeSessionById.get(String(snapshot.current.id)));
  for (const collection of [snapshot.history, legacyBackupState.history]) {
    for (const item of collection) {
      const id = item?.id ?? item?.session?.id;
      if (id != null && safeSessionById.has(String(id)) && item?.session) item.session = clone(safeSessionById.get(String(id)));
    }
  }
  if (snapshot.current?.id != null && safeSessionById.has(String(snapshot.current.id)))
    legacyBackupState.current = clone(safeSessionById.get(String(snapshot.current.id)));

  const payload = {version: 2, schemaVersion: '2.0.0', appVersion: null,
    appAssetVersion: APP_ASSET_VERSION, appVersionMissingReason: APP_ASSET_VERSION ? null : '运行环境未提供本地静态资源版本参数。',
    exportedAt, exportSnapshotAt: new Date(snapshotAt).toISOString(),
    purpose: '供GPT复盘练习中的交易行为与当时判断；每轮严格按各自可见截止裁剪行情。',
    noFutureData: true, deduplicatedSessions: rounds.duplicates,
    legacyStateBackup: {sourceSchema: 'V1 current/history 兼容状态备份', status: '保留未知字段；可能含未揭示行情的forming15m保留字段位置和脱敏标记，不保留完整未来OHLCV。',
      redactions: legacyRedactions, current: legacyBackupState.current, history: legacyBackupState.history},
    dataDictionary: {timestamp: 'Unix epoch seconds，UTC；时间为K线openTime。',
      intervalBoundary: '区间左闭右开；完整K线仅当openTime+interval<=visibleThrough时导出。',
      backgroundObservationInterval: '15分钟原始OHLCV，覆盖当时回放场景的背景观察/热身；不代表该期间已逐分钟回放。',
      replayExecutionInterval: '1分钟真实OHLCV，只覆盖逐步揭示并落入该轮visibleThrough之前的区间。',
      visibleThrough: '每轮及事件各自的排他收盘边界。',
      row: ['openTime', 'open', 'high', 'low', 'close', 'volume'], price: 'USDT per BTC/ETH',
      volume: '基础资产数量BTC或ETH，不是USDT成交额；源数据数值精度原样保留。'},
    simulationModel: {marketProduct: 'Binance现货历史OHLCV', executionModel: '本地自定义逐仓杠杆模拟，不是交易所合约或真实成交。',
      currentEngineDeclaration: {id: 'isolated-v1', maintenanceMarginRate: 0.005, feeRate: 0.0004, slippageRate: 0.0002,
        feeBasis: '名义成交额；单边手续费在对应成交发生时计入。', leverage: '模拟1至100倍逐仓。',
        budget: '预算=账户余额*sizePercent/100；名义仓位=floor2(预算/(1/leverage+feeRate))；该比例用于保证金+入场手续费，不是亏损预算。',
        historicalApplicability: '只描述导出时当前引擎；旧记录没有模型配置证据时不代表历史采用该配置。',
        intrabar: '一分钟OHLC不能证明分钟内先后；若触发条件冲突，仅能按引擎规则模拟。'},
      historicalModelVersion: '历史版本未保存时为未知。'},
    source: {provider: 'Binance Vision 现货公开归档', timezone: 'UTC',
      rawCandleColumns: ['openTime', 'open', 'high', 'low', 'close', 'volume'],
      prices: 'USDT per BTC/ETH', volume: '基础资产数量（BTC或ETH），不是USDT成交额',
      timestamps: 'Unix epoch seconds', ...commonModelRates(sessions)}, current: snapshot.current, history: snapshot.history, sessions};
  const reviewBookHtml = renderReviewBook(sessions);
  const report = buildReviewReport(payload);
  if (report && typeof report === 'object' && report.metricsBySession) payload.metricsBySession = report.metricsBySession;
  const reportText = typeof report === 'string' ? report : report?.reportText;
  if (typeof reportText !== 'string' || !reportText.trim()) throw new Error('复盘报告模块没有返回有效中文报告。');
  const recordBytes = utf8.encode(JSON.stringify(payload, null, 2));
  const files = [{name: '复盘报告.md', bytes: utf8.encode(reportText)}, {name: '复盘册.html', bytes: utf8.encode(reviewBookHtml)},
    {name: '完整记录.json', bytes: recordBytes}, ...screenshotFiles];
  const manifestEntries = [];
  for (const file of files) manifestEntries.push({path: file.name, bytes: file.bytes.length, sha256: await sha256(file.bytes)});
  const manifest = {version: 1, generatedAt: exportedAt, totalFileCountIncludingManifest: files.length + 1,
    hashedFileCount: manifestEntries.length, selfHashExcluded: true, files: manifestEntries,
    sessions: sessions.map(item => ({id: item.id, slot: item.slot, captureCoverageComplete: item.coverage?.captureCoverageComplete ?? false,
      evidenceComplete: item.coverage?.evidenceComplete ?? false, evidenceCoverage: item.coverage?.evidenceCoverage ?? {},
      marketComplete: item.coverage?.marketComplete ?? false, auditComplete: item.coverage?.auditComplete ?? false,
      screenshotsComplete: item.coverage?.screenshotsComplete ?? false, baseline: item.coverage?.baseline ?? null,
      recordingStartedAt: item.coverage?.auditRecordingStartedAt ?? item.coverage?.recordingStartedAt ?? null,
      screenshotCoverage: item.coverage?.screenshotCoverage ?? {expectedKeyActionCount: 0, availableScreenshotCount: 0, missingScreenshotCount: 0, missingEventIds: []},
      visibleThrough: item.coverage?.visibleThrough ?? null, expectedMinuteRows: item.coverage?.expectedMinuteRows ?? 0,
      availableMinuteRows: item.coverage?.availableMinuteRows ?? 0, missingMinuteRows: item.coverage?.missingMinuteRows ?? 0,
      futureFiltered: item.coverage?.futureFiltered ?? {minuteRows: 0, auditEvents: 0, forming15mFinalBar: 0},
      gaps: item.coverage?.gaps ?? [], issues: item.issues ?? []}))};
  files.push({name: '文件清单.json', bytes: utf8.encode(JSON.stringify(manifest, null, 2))});
  const blob = createZip(files);
  return {blob, filename: `K线回放复盘_${exportedAt.slice(0, 10)}.zip`, reportText, reviewBookHtml,
    metricsBySession: payload.metricsBySession ?? null, issues, manifest, payload};
}
