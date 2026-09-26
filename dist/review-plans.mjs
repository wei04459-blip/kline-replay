function copy(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function nextVersion(plans, planId) {
  return 1 + (plans || []).reduce((max, item) => item?.planId === planId ? Math.max(max, Number(item.version) || 0) : max, 0);
}

export function createPlanVersion({session, planId, version, parentPlanId = null, rawText = '', structured = null,
  author = 'user', origin = 'user', timingClass = 'pre-trade', captureStartedAt, captureEndedAt, submittedAt,
  visibleThrough = null, replayMarketTime = null, snapshotId = null, orderId = null, tradeId = null,
  order = null, account = null, risk = null, modelConfigId = null, actor = 'user', thesisId = null,
  parentTradeId = null, parentSessionId = null, attemptNumber = null, strategyVersion = null, observationId = null,
  captureStartedView = null, captureStartedAccount = null, captureStartedInPosition = false} = {}) {
  if (!session || typeof planId !== 'string' || !planId) throw new TypeError('计划需要稳定的 planId');
  const stamp = new Date().toISOString();
  const plans = Array.isArray(session.reviewPlans) ? session.reviewPlans : [];
  return copy({
    planId,
  version: Number.isInteger(version) && version > 0 ? version : nextVersion(plans, planId),
    parentVersion: Number.isInteger(version) && version > 1 ? version - 1 : null,
    parentPlanId: typeof parentPlanId === 'string' ? parentPlanId : null,
    sessionId: String(session.id),
    orderId: orderId || null,
    tradeId: tradeId || null,
    rawText: typeof rawText === 'string' ? rawText : '',
    structured: structured && typeof structured === 'object' ? structured : null,
    author,
    origin,
    timingClass,
    captureStartedAt: captureStartedAt || stamp,
    captureEndedAt: captureEndedAt || submittedAt || stamp,
    submittedAt: submittedAt || null,
    recordedAt: stamp,
    replayMarketTime: Number.isFinite(replayMarketTime) ? replayMarketTime : null,
    visibleThrough: Number.isFinite(visibleThrough) ? visibleThrough : null,
    visibleThroughSemantics: 'exclusive-market-close-utc-seconds',
    snapshotId: snapshotId || null,
    modelConfigId: modelConfigId || session.modelConfigId || session.modelEvidence?.modelConfigId || null,
    thesisId: thesisId || null,
    parentTradeId: parentTradeId || null,
    parentSessionId: parentSessionId || null,
    attemptNumber: Number.isInteger(attemptNumber) && attemptNumber > 0 ? attemptNumber : null,
    strategyVersion: typeof strategyVersion === 'string' && strategyVersion.trim() ? strategyVersion : null,
    observationId: observationId || null,
    captureStartedView: copy(captureStartedView),
    captureStartedAccount: copy(captureStartedAccount),
    captureStartedInPosition: captureStartedInPosition === true,
    actor,
    order: copy(order),
    account: copy(account),
    risk: copy(risk)
  });
}

// If an automatic exit closes a position while the user is writing a
// supplement, attach the new post-trade version to that exact trade. Never
// guess from a side or approximate price alone.
export function findClosedTradeForPosition(trades, position) {
  if (!Array.isArray(trades) || !position) return null;
  const same = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
  let matches = [];
  const orderId = position.orderId || position.positionId;
  if (orderId) {
    matches = trades.filter(trade => same(trade?.orderId, orderId) || same(trade?.positionId, orderId));
  }
  if (!matches.length) {
    const hasEntryTime = position.entryTime !== undefined && position.entryTime !== null;
    const hasEntryIndex = position.entryIndex !== undefined && position.entryIndex !== null;
    if (!hasEntryTime && !hasEntryIndex) return null;
    matches = trades.filter(trade => same(trade?.side, position.side) && same(trade?.entry, position.entry) &&
      (hasEntryTime ? same(trade?.entryTime, position.entryTime) : same(trade?.entryIndex, position.entryIndex)));
  }
  return matches.length === 1 ? matches[0] : null;
}

export function appendPlanVersion(session, version) {
  if (!session || !version?.planId || !Number.isInteger(version.version)) throw new TypeError('计划版本格式无效');
  if (!Array.isArray(session.reviewPlans)) session.reviewPlans = [];
  if (session.reviewPlans.some(item => item.planId === version.planId && item.version === version.version)) {
    throw new Error('计划版本已存在，不能覆盖原始记录');
  }
  session.reviewPlans.push(copy(version));
  return session.reviewPlans.at(-1);
}

export function modificationEvidence({before, after, reason = null, recordedAt = new Date().toISOString(),
  replayMarketTime = null, visibleThrough = replayMarketTime, riskChanges = null} = {}) {
  return copy({
    before,
    after,
    reason: typeof reason === 'string' && reason.trim() ? reason : null,
    recordedAt,
    replayMarketTime: Number.isFinite(replayMarketTime) ? replayMarketTime : null,
    visibleThrough: Number.isFinite(visibleThrough) ? visibleThrough : null,
    visibleThroughSemantics: 'exclusive-market-close-utc-seconds',
    riskChanges: Array.isArray(riskChanges) ? riskChanges : []
  });
}

export function executionStageSnapshots(beforeState, progressedState, stage) {
  const clock = stage?.replayState || progressedState || {};
  const clockFields = {
    cursor: clock.cursor ?? progressedState?.cursor ?? beforeState?.cursor ?? null,
    minuteCursorTime: clock.minuteCursorTime ?? progressedState?.minuteCursorTime ?? beforeState?.minuteCursorTime ?? null,
    forming15m: clock.forming15m ?? progressedState?.forming15m ?? beforeState?.forming15m ?? null,
    currentPrice: clock.currentPrice ?? progressedState?.currentPrice ?? beforeState?.currentPrice ?? null
  };
  const make = (part, accountPart) => {
    const values = copy(part) || {};
    const account = stage?.account?.[accountPart] || {};
    return copy({
      ...(copy(beforeState) || {}), ...clockFields, ...values,
      account: {balance: account.balance ?? values.balance ?? beforeState?.account?.balance ?? null,
        stage: 'engine-execution-stage', ...copy(account)}
    });
  };
  return {before: make(stage?.before, 'before'), after: make(stage?.after, 'after')};
}
