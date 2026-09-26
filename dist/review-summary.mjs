const finite = value => typeof value === 'number' && Number.isFinite(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function epoch(value) {
  if (finite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

function explicitId(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function linkedTrade(session, orderId) {
  return (session.trades ?? []).find(trade => trade.orderId === orderId) ?? null;
}

function orderForTrade(session, trade) {
  return (session.orders ?? []).find(order => order.id === trade.orderId) ??
    (session.orderHistory ?? []).find(order => order.id === trade.orderId) ?? null;
}

function planForOrder(session, order) {
  if (!order) return null;
  return (session.reviewPlans ?? []).find(plan => plan.planId === order.planId &&
    (!plan.orderId || plan.orderId === order.id)) ?? null;
}

function entryFillForTrade(session, trade) {
  if (trade.entryFillId) return (session.fills ?? []).find(fill => fill.id === trade.entryFillId) ?? null;
  return (session.fills ?? []).find(fill => fill.side === 'entry' &&
    (fill.positionId === trade.positionId || (!!trade.orderId && fill.orderId === trade.orderId))) ?? null;
}

function lockedR0(trade, fill) {
  if (own(trade, 'initialRiskR0')) return finite(trade.initialRiskR0) && trade.initialRiskR0 > 0 ? trade.initialRiskR0 : null;
  if (fill && own(fill, 'initialRiskR0')) return finite(fill.initialRiskR0) && fill.initialRiskR0 > 0 ? fill.initialRiskR0 : null;
  const source = trade && own(trade, 'initialStop') ? trade : fill && own(fill, 'initialStop') ? fill : null;
  if (!source || source.initialStop === null || !finite(source.initialStop)) return null;
  const entry = finite(trade.entry) ? trade.entry : fill?.price;
  const qty = finite(trade.qty) ? trade.qty : fill?.qty;
  if (!finite(entry) || entry <= 0 || !finite(qty) || qty <= 0 || ![1, -1].includes(trade.side)) return null;
  if (trade.side === 1 ? source.initialStop >= entry : source.initialStop <= entry) return null;
  return Math.abs(entry - source.initialStop) * qty;
}

function evidenceForTrade(session, trade) {
  const order = orderForTrade(session, trade);
  const plan = planForOrder(session, order);
  const fill = entryFillForTrade(session, trade);
  let fees = finite(trade.fees) ? trade.fees : null;
  if (fees === null && trade.entryFillId && trade.exitFillId) {
    const entryFee = (session.fills ?? []).find(item => item.id === trade.entryFillId)?.fee;
    const exitFee = (session.fills ?? []).find(item => item.id === trade.exitFillId)?.fee;
    if (finite(entryFee) && finite(exitFee)) fees = entryFee + exitFee;
  }
  const lossBudget = finite(trade.riskBudget?.lossBudget) ? trade.riskBudget.lossBudget
    : finite(order?.riskBudget?.lossBudget) ? order.riskBudget.lossBudget
      : finite(plan?.risk?.lossBudget) ? plan.risk.lossBudget
        : finite(plan?.lossBudget) ? plan.lossBudget : null;
  return {order, plan, fill, fees, initialR0: lockedR0(trade, fill), lossBudget,
    thesisId: explicitId(trade.thesisId, order?.thesisId, plan?.thesisId),
    parentTradeId: explicitId(trade.parentTradeId, order?.parentTradeId, plan?.parentTradeId),
    strategyVersion: explicitId(trade.strategyVersion, order?.strategyVersion, plan?.strategyVersion),
    attemptNumber: Number.isInteger(trade.attemptNumber) && trade.attemptNumber > 0 ? trade.attemptNumber
      : Number.isInteger(order?.attemptNumber) && order.attemptNumber > 0 ? order.attemptNumber : null};
}

function eventFor(events, order, trade, kindPattern) {
  const tradeId = explicitId(trade?.tradeId, trade?.id);
  const orderId = explicitId(trade?.orderId, order?.id);
  return events.filter(event => kindPattern.test(String(event.kind ?? '')) &&
    (tradeId && String(event.tradeId ?? '') === tradeId || orderId && String(event.orderId ?? '') === orderId))
    .sort((a, b) => (Number.isInteger(a.seq) ? a.seq : Infinity) - (Number.isInteger(b.seq) ? b.seq : Infinity))[0] ?? null;
}

function tradeMetrics(session, trade, events) {
  const evidence = evidenceForTrade(session, trade);
  const netPnl = finite(trade.pnl) ? trade.pnl : null;
  const entryEvent = eventFor(events, evidence.order, trade, /order-filled|position-opened|entry-fill/);
  const exitEvent = eventFor(events, evidence.order, trade, /position-(?:auto-)?closed|trade-closed|liquidat/);
  const entryTime = epoch(trade.entryTime) ?? epoch(evidence.fill?.time) ?? epoch(entryEvent?.marketTime ?? entryEvent?.replayMarketTime ?? entryEvent?.visibleThrough);
  const exitFill = trade.exitFillId ? (session.fills ?? []).find(fill => fill.id === trade.exitFillId) : null;
  const exitTime = epoch(trade.exitTime) ?? epoch(exitFill?.time) ?? epoch(exitEvent?.marketTime ?? exitEvent?.replayMarketTime ?? exitEvent?.visibleThrough);
  const notional = finite(trade.notional) && trade.notional > 0 ? trade.notional
    : finite(trade.entry) && trade.entry > 0 && finite(trade.qty) && trade.qty > 0 ? trade.entry * trade.qty : null;
  return {trade, evidence, entryTime, exitTime, entrySeq: Number.isInteger(entryEvent?.seq) ? entryEvent.seq : null,
    exitSeq: Number.isInteger(exitEvent?.seq) ? exitEvent.seq : null, notional, netPnl, fees: evidence.fees};
}

function attemptRecord(item) {
  const {trade, evidence} = item;
  return {tradeId: explicitId(trade?.tradeId, trade?.id), orderId: evidence.order?.id ?? trade?.orderId ?? null,
    parentTradeId: evidence.parentTradeId, attemptNumber: evidence.attemptNumber,
    status: evidence.order?.status ?? (trade ? 'closed' : 'unknown'),
    netPnl: item.netPnl, fees: item.fees, initialR0: evidence.initialR0, lossBudget: evidence.lossBudget,
    riskEvidence: evidence.initialR0 === null ? 'locked-fill-risk-unavailable' : 'locked-fill-risk'};
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function summarizeGroup(id, items, exposure = null, label = null) {
  const attempts = items.map(attemptRecord);
  const knownPnl = attempts.filter(item => finite(item.netPnl));
  const knownFees = attempts.filter(item => finite(item.fees));
  const tradeCount = items.filter(item => item.trade).length;
  return {id: id === '\u0000unknown' ? null : id, label, exposure, attemptCount: attempts.length,
    tradeCount,
    netPnl: tradeCount > 0 && knownPnl.length === tradeCount ? knownPnl.reduce((sum, item) => sum + item.netPnl, 0) : null,
    netPnlKnownCount: knownPnl.length, fees: knownFees.length === items.filter(item => item.trade).length
      && tradeCount > 0 ? knownFees.reduce((sum, item) => sum + item.fees, 0) : null,
    feesKnownCount: knownFees.length, attempts};
}

function buildExposure(sessionRecord, tradeRows, thesisKey = null, filterThesis = false) {
  const session = sessionRecord.session;
  const belongsToThesis = value => {
    const key = explicitId(value?.thesisId) ?? '\u0000unknown';
    return key === thesisKey;
  };
  const items = filterThesis ? tradeRows.filter(row => belongsToThesis(row.trade)) : [...tradeRows];
  const includePosition = session.position && (!filterThesis || belongsToThesis(session.position));
  if (includePosition) {
    const pseudoTrade = {...session.position, orderId: session.position.orderId ?? null};
    const evidence = evidenceForTrade(session, pseudoTrade);
    const events = Array.isArray(sessionRecord.events) ? sessionRecord.events : [];
    const entryEvent = eventFor(events, evidence.order, pseudoTrade, /order-filled|position-opened|entry-fill/);
    const entryTime = epoch(session.position.entryTime) ?? epoch(entryEvent?.marketTime ?? entryEvent?.visibleThrough);
    const notional = finite(session.position.notional) ? session.position.notional
      : finite(session.position.entry) && finite(session.position.qty) ? session.position.entry * session.position.qty : null;
    const cutoff = epoch(sessionRecord.coverage?.visibleThrough ?? (finite(session.minuteCursorTime) ? session.minuteCursorTime + 60 : null));
    items.push({trade: null, entryTime, exitTime: cutoff, entrySeq: Number.isInteger(entryEvent?.seq) ? entryEvent.seq : null,
      exitSeq: null, notional, orderId: session.position.orderId ?? null, isOpen: true});
  }
  if (!items.length) return {available: true, maxConcurrentNotional: 0, intervalCount: 0,
    method: 'closed trade entry-to-exit intervals plus current position; pending orders excluded'};
  const missing = items.filter(item => !finite(item.entryTime) || !finite(item.exitTime) || !finite(item.notional) || item.notional <= 0);
  if (missing.length) return {available: false, maxConcurrentNotional: null, intervalCount: items.length,
    unknownIntervals: missing.map(item => item.orderId ?? explicitId(item.trade?.tradeId, item.trade?.id) ?? 'unknown'),
    reason: '至少一笔持仓缺少精确入场/退出时间或名义金额；最大同时敞口未知。',
    method: '按披露的仓位生命周期重建；限价挂单不计入持仓敞口'};
  const points = [];
  let unresolvedSameTime = false;
  for (const item of items) {
    let entrySeq = item.entrySeq, exitSeq = item.exitSeq;
    if (item.entryTime === item.exitTime && (!Number.isInteger(entrySeq) || !Number.isInteger(exitSeq) || entrySeq === exitSeq)) unresolvedSameTime = true;
    points.push({time: item.entryTime, seq: entrySeq ?? 0, delta: item.notional, orderId: item.orderId});
    points.push({time: item.exitTime, seq: exitSeq ?? Number.MAX_SAFE_INTEGER, delta: -item.notional, orderId: item.orderId});
  }
  if (unresolvedSameTime) return {available: false, maxConcurrentNotional: null, intervalCount: items.length,
    reason: '同一市场秒内入场与退出缺少可核验的事件序号；不能确定阶段敞口。',
    method: '按披露的仓位生命周期重建；限价挂单不计入持仓敞口'};
  points.sort((a, b) => a.time - b.time || a.seq - b.seq || a.delta - b.delta);
  let exposure = 0, peak = 0;
  for (const point of points) { exposure += point.delta; peak = Math.max(peak, exposure); }
  return {available: true, maxConcurrentNotional: peak, intervalCount: items.length,
    method: '按披露的entry/exit时间和同分钟引擎事件序号重建；限价挂单不计入，分钟内实际先后未知'};
}

/** Aggregate only explicit thesis, strategy, order, fill, and observation relationships. */
export function buildReviewSummary(input) {
  const sessionRecord = input?.session ? input : {session: input};
  const session = sessionRecord.session;
  if (!session || typeof session !== 'object') throw new TypeError('复盘汇总需要session或{session,events,coverage}对象。');
  const events = Array.isArray(sessionRecord.events) ? sessionRecord.events : [];
  const trades = Array.isArray(session.trades) ? session.trades : [];
  const tradeRows = trades.map(trade => tradeMetrics(session, trade, events));
  const byOrder = new Map(tradeRows.map(item => [item.trade?.orderId, item]));
  const seenOrders = new Set();
  const attempts = [];
  for (const order of Array.isArray(session.orders) ? session.orders : []) {
    const row = byOrder.get(order.id);
    if (row) { attempts.push(row); seenOrders.add(order.id); continue; }
    const plan = planForOrder(session, order);
    const syntheticTrade = {orderId: order.id, thesisId: order.thesisId ?? plan?.thesisId,
      strategyVersion: order.strategyVersion ?? plan?.strategyVersion,
      attemptNumber: order.attemptNumber, riskBudget: order.riskBudget};
    attempts.push({...tradeMetrics(session, syntheticTrade, events), trade: null, netPnl: null,
      fees: null, notional: finite(order.notional) ? order.notional : null, evidence: {...evidenceForTrade(session, syntheticTrade), order, plan}});
    seenOrders.add(order.id);
  }
  for (const row of tradeRows) if (!row.trade?.orderId || !seenOrders.has(row.trade.orderId)) attempts.push(row);

  const thesisMap = new Map((Array.isArray(session.theses) ? session.theses : []).map(thesis =>
    [explicitId(thesis.thesisId, thesis.id), thesis]).filter(([id]) => id));
  const thesisSummaries = [...groupBy(attempts, item => item.evidence.thesisId ?? '\u0000unknown')]
    .map(([id, rows]) => summarizeGroup(id, rows,
      buildExposure(sessionRecord, tradeRows, id, true), id === '\u0000unknown' ? null
        : thesisMap.get(id)?.label ?? thesisMap.get(id)?.title ?? null));
  const strategySummaries = [...groupBy(attempts, item => item.evidence.strategyVersion ?? '\u0000unknown')]
    .map(([id, rows]) => summarizeGroup(id, rows));
  const observations = (Array.isArray(session.observations) ? session.observations : []).map(item => {
    const relatedEvents = events.filter(event =>
      (item.observationId && event.observationId === item.observationId) ||
      (item.snapshotId && event.snapshotId === item.snapshotId) ||
      (item.chartSnapshotId && event.snapshotId === item.chartSnapshotId));
    const relatedShots = (sessionRecord.auditScreenshots ?? []).filter(shot => relatedEvents.some(event => event.id === shot.eventId));
    const observedConditions = item.observedConditions;
    return {observationId: item.observationId ?? null, thesisId: item.thesisId ?? null,
      status: item.status ?? 'unknown', rawText: typeof item.rawText === 'string' ? item.rawText : null,
      condition: typeof item.condition === 'string' ? item.condition : typeof item.conditions === 'string' ? item.conditions
        : typeof observedConditions === 'string' ? observedConditions : null,
      conditions: Array.isArray(item.conditions) ? item.conditions.slice() : Array.isArray(observedConditions) ? observedConditions.slice() : undefined,
      recordedAt: item.recordedAt ?? null, visibleThrough: epoch(item.visibleThrough ?? item.replayMarketTime),
      timingKnown: epoch(item.visibleThrough ?? item.replayMarketTime) !== null,
      snapshotId: item.snapshotId ?? item.chartSnapshotId ?? item.viewSnapshotId ?? null,
      chartRef: item.chartRef ?? item.drawingVersionId ?? null,
      eventIds: relatedEvents.map(event => event.id).filter(Boolean), screenshotRefs: relatedShots.map(shot => ({id: shot.id, path: shot.path ?? null}))};
  });
  const exposure = buildExposure(sessionRecord, tradeRows);
  const warnings = [];
  if (thesisSummaries.some(item => item.id === null)) warnings.push('部分交易没有显式thesisId，未按理由文本或时间猜测想法归属。');
  if (strategySummaries.some(item => item.id === null)) warnings.push('部分订单没有显式strategyVersion，保留为版本未知。');
  if (!exposure.available) warnings.push(exposure.reason);
  if (tradeRows.some(item => item.evidence.initialR0 === null)) warnings.push('部分成交没有实际成交时锁定的初始R0；没有用后来修改的止损替代。');
  return {sessionId: session.id ?? sessionRecord.id ?? null, thesisSummaries, strategySummaries, observations, exposure, warnings};
}

function mdText(value) {
  if (value == null || value === '') return '未记录';
  return String(value).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+.!|>\-])/g, '\\$1').replace(/\r?\n/g, '<br>');
}

function fmt(value, digits = 2) { return finite(value) ? value.toFixed(digits) : '未知'; }

/** Render safe Chinese prose; raw user text remains present but cannot inject Markdown structure. */
export function formatReviewSummary(summary) {
  if (!summary || !Array.isArray(summary.thesisSummaries) || !Array.isArray(summary.strategySummaries))
    throw new TypeError('复盘汇总结构无效。');
  const theses = summary.thesisSummaries.map(group =>
    `- ${group.id === null ? '未关联想法的订单集合' : `想法 ${mdText(group.label ?? '未命名想法')}（${mdText(String(group.id).slice(0, 8))}）`}：${group.attemptCount}次尝试，已记录交易${group.tradeCount}笔；净盈亏${fmt(group.netPnl)} U，手续费${fmt(group.fees)} U；该组最大同时名义敞口${group.exposure?.available ? `${fmt(group.exposure.maxConcurrentNotional)} U` : '未知'}。${group.attempts.map((attempt, index) =>
      `\n  - 第${index + 1}次：订单 ${mdText(attempt.orderId)}，attemptNumber ${attempt.attemptNumber ?? '未知'}，净盈亏 ${fmt(attempt.netPnl)} U，手续费 ${fmt(attempt.fees)} U，成交时锁定R0 ${fmt(attempt.initialR0)} U，用户预算 ${fmt(attempt.lossBudget)} U。`).join('')}`).join('\n') || '没有可按明确thesisId归组的交易。';
  const strategies = summary.strategySummaries.map(group =>
    `- 策略版本 ${mdText(group.id)}：${group.attemptCount}次订单尝试，关联交易${group.tradeCount}笔；净盈亏${fmt(group.netPnl)} U，手续费${fmt(group.fees)} U。`).join('\n') || '没有策略版本分组数据。';
  const observations = summary.observations.map(item =>
    `- 观察 ${mdText(item.observationId)}（想法 ${mdText(item.thesisId)}，${mdText(item.status)}，时间 ${mdText(item.visibleThrough)}）：条件 ${mdText(item.condition ?? item.conditions?.join('；'))}；原文 ${mdText(item.rawText)}；图表引用 ${mdText(item.chartRef ?? item.snapshotId)}；截图 ${item.screenshotRefs.map(shot => mdText(shot.path ?? shot.id)).join(', ') || '未关联'}。`).join('\n') || '没有未下单观察记录。';
  const exposure = summary.exposure?.available
    ? `最大同时名义敞口 ${fmt(summary.exposure.maxConcurrentNotional)} U；${summary.exposure.method}。`
    : `最大同时名义敞口未知；${mdText(summary.exposure?.reason ?? '缺少可核验持仓区间。')}`;
  const warnings = summary.warnings?.length ? `\n\n数据限制：\n${summary.warnings.map(item => `- ${mdText(item)}`).join('\n')}` : '';
  return `### 明确想法、策略版本与观察\n\n#### 同一想法的订单尝试\n${theses}\n\n#### 策略版本分组\n${strategies}\n\n#### 未下单观察\n${observations}\n\n#### 敞口\n${exposure}${warnings}`;
}
