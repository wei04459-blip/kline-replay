import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewSummary, formatReviewSummary} from '../dist/review-summary.mjs';

function fixture() {
  const t1 = {id: 'trade-1', tradeId: 'trade-1', orderId: 'order-1', positionId: 'position-1', side: 1,
    entry: 100, exit: 110, qty: 10, notional: 1000, entryTime: 1000, exitTime: 1600,
    pnl: 80, fees: 10, initialStop: 95, initialRiskR0: 50, stop: 108, thesisId: 'idea-A',
    strategyVersion: 'setup-v1', attemptNumber: 1};
  const t2 = {id: 'trade-2', tradeId: 'trade-2', orderId: 'order-2', positionId: 'position-2', side: -1,
    entry: 100, exit: 90, qty: 5, notional: 500, entryTime: 1400, exitTime: 1700,
    pnl: 40, fees: 5, initialStop: 105, initialRiskR0: 25, stop: 92, thesisId: 'idea-A',
    strategyVersion: 'setup-v2', attemptNumber: 2};
  const orders = [
    {id: 'order-1', planId: 'plan-1', thesisId: 'idea-A', strategyVersion: 'setup-v1', attemptNumber: 1,
      riskBudget: {lossBudget: 100}, status: 'filled'},
    {id: 'order-2', planId: 'plan-2', thesisId: 'idea-A', strategyVersion: 'setup-v2', attemptNumber: 2,
      parentTradeId: 'trade-1', riskBudget: {lossBudget: 75}, status: 'filled'},
    {id: 'order-3', planId: 'plan-3', thesisId: 'idea-B', status: 'cancelled'},
  ];
  const session = {id: 'round-1', symbol: 'BTCUSDT', trades: [t1, t2], orders,
    orderHistory: [{id: 'order-3', status: 'cancelled'}], fills: [], reviewPlans: [
      {planId: 'plan-1', orderId: 'order-1', thesisId: 'idea-A', risk: {lossBudget: 100}},
      {planId: 'plan-2', orderId: 'order-2', thesisId: 'idea-A', risk: {lossBudget: 75}},
      {planId: 'plan-3', orderId: 'order-3', thesisId: 'idea-B', risk: {lossBudget: 20}},
    ], theses: [{thesisId: 'idea-A', label: '区间回踩'}], observations: [
      {observationId: 'obs-1', thesisId: 'idea-A', status: 'not-taken', rawText: '等突破后再做',
        observedConditions: '收盘高于区间上沿', visibleThrough: 1200, snapshotId: 'snap-1', drawingVersionId: 'drawing-v2'}
    ]};
  const events = [
    {id: 'open-1', seq: 1, kind: 'order-filled', orderId: 'order-1', tradeId: 'trade-1', marketTime: 1000},
    {id: 'open-2', seq: 2, kind: 'order-filled', orderId: 'order-2', tradeId: 'trade-2', marketTime: 1400},
    {id: 'obs-event', seq: 3, kind: 'observation-recorded', observationId: 'obs-1', snapshotId: 'snap-1', visibleThrough: 1200},
    {id: 'close-1', seq: 4, kind: 'position-auto-closed', orderId: 'order-1', tradeId: 'trade-1', marketTime: 1600},
    {id: 'close-2', seq: 5, kind: 'position-auto-closed', orderId: 'order-2', tradeId: 'trade-2', marketTime: 1700},
  ];
  const auditScreenshots = [{id: 'shot-1', eventId: 'obs-event', path: '截图/observe.png'}];
  return {sessionRecord: {session, events, auditScreenshots, coverage: {visibleThrough: 1800}}, session, events};
}

test('explicit thesis groups aggregate attempts, net PnL, fees, locked R0 and budgets without guessing', () => {
  const {sessionRecord} = fixture();
  const summary = buildReviewSummary(sessionRecord);
  const idea = summary.thesisSummaries.find(item => item.id === 'idea-A');
  assert.equal(idea.attemptCount, 2);
  assert.equal(idea.tradeCount, 2);
  assert.equal(idea.netPnl, 120);
  assert.equal(idea.fees, 15);
  assert.equal(idea.label, '区间回踩');
  assert.equal(idea.exposure.available, true);
  assert.equal(idea.exposure.maxConcurrentNotional, 1500);
  assert.deepEqual(idea.attempts.map(item => item.initialR0), [50, 25]);
  assert.deepEqual(idea.attempts.map(item => item.lossBudget), [100, 75]);
  assert.deepEqual(idea.attempts.map(item => item.attemptNumber), [1, 2]);
  assert.deepEqual(idea.attempts.map(item => item.parentTradeId), [null, 'trade-1']);
  const noTradeIdea = summary.thesisSummaries.find(item => item.id === 'idea-B');
  assert.equal(noTradeIdea.attemptCount, 1);
  assert.equal(noTradeIdea.tradeCount, 0);
  assert.equal(noTradeIdea.netPnl, null);
  assert.equal(noTradeIdea.fees, null);
});

test('strategy versions stay explicitly separated and unlabelled attempts remain unknown', () => {
  const {sessionRecord} = fixture();
  const summary = buildReviewSummary(sessionRecord);
  assert.deepEqual(summary.strategySummaries.filter(item => item.id).map(item => item.id).sort(), ['setup-v1', 'setup-v2']);
  assert.ok(summary.strategySummaries.some(item => item.id === null && item.attemptCount === 1));
  assert.ok(summary.warnings.some(item => item.includes('strategyVersion')));
  assert.match(formatReviewSummary(summary), /策略版本 setup\\-v1/);
  assert.match(formatReviewSummary(summary), /想法 区间回踩（idea\\-A）/);
  assert.match(formatReviewSummary(summary), /想法 未命名想法/);
});

test('attempts without explicit thesis links are labeled as an unassociated order set', () => {
  const {sessionRecord} = fixture();
  delete sessionRecord.session.orders[2].thesisId;
  delete sessionRecord.session.reviewPlans[2].thesisId;
  assert.match(formatReviewSummary(buildReviewSummary(sessionRecord)), /未关联想法的订单集合/);
});

test('maximum simultaneous notional exposure uses timestamped position intervals, not pending orders', () => {
  const {sessionRecord} = fixture();
  const summary = buildReviewSummary(sessionRecord);
  assert.equal(summary.exposure.available, true);
  assert.equal(summary.exposure.maxConcurrentNotional, 1500);
  assert.equal(summary.exposure.intervalCount, 2);
  assert.match(summary.exposure.method, /限价挂单不计入/);
});

test('exposure is unknown when position time or notional evidence is missing', () => {
  const {sessionRecord, session} = fixture();
  session.position = {side: 1, entry: 100, qty: null, notional: null, entryTime: null, orderId: 'open-now'};
  session.minuteCursorTime = null;
  sessionRecord.coverage.visibleThrough = null;
  sessionRecord.events = [];
  const summary = buildReviewSummary(sessionRecord);
  assert.equal(summary.exposure.available, false);
  assert.equal(summary.exposure.maxConcurrentNotional, null);
  assert.match(summary.exposure.reason, /时间或名义金额/);
});

test('same-minute entry and exit use engine event order to include the brief simulated exposure', () => {
  const trade = {id: 'same', tradeId: 'same', orderId: 'same-order', positionId: 'same-position', side: 1,
    entry: 100, exit: 101, qty: 5, notional: 500, entryTime: 1200, exitTime: 1200, pnl: 4, fees: 1};
  const summary = buildReviewSummary({session: {id: 'same-minute', trades: [trade], orders: [{id: 'same-order'}]},
    events: [{id: 'f', seq: 10, kind: 'order-filled', orderId: 'same-order', tradeId: 'same', marketTime: 1200},
      {id: 'x', seq: 11, kind: 'position-auto-closed', orderId: 'same-order', tradeId: 'same', marketTime: 1200}]});
  assert.equal(summary.exposure.available, true);
  assert.equal(summary.exposure.maxConcurrentNotional, 500);
});

test('observation text, conditions, timing and screenshot references are preserved', () => {
  const {sessionRecord} = fixture();
  const observation = buildReviewSummary(sessionRecord).observations[0];
  assert.equal(observation.rawText, '等突破后再做');
  assert.equal(observation.condition, '收盘高于区间上沿');
  assert.equal(observation.visibleThrough, 1200);
  assert.equal(observation.snapshotId, 'snap-1');
  assert.equal(observation.chartRef, 'drawing-v2');
  assert.deepEqual(observation.screenshotRefs, [{id: 'shot-1', path: '截图/observe.png'}]);
});

test('final stop is never substituted for unknown fill-time R0 and user text cannot inject report structure', () => {
  const {sessionRecord, session} = fixture();
  session.trades[0].initialRiskR0 = null;
  delete session.trades[0].initialStop;
  session.trades[0].stop = 1;
  session.observations[0].rawText = '### fake\n- injected';
  const summary = buildReviewSummary(sessionRecord);
  assert.equal(summary.thesisSummaries.find(item => item.id === 'idea-A').attempts[0].initialR0, null);
  assert.match(formatReviewSummary(summary), /\\#\\#\\# fake<br>\\- injected/);
  assert.ok(summary.warnings.some(item => item.includes('初始R0')));
});

test('same-session object form and missing observation time remain supported without inventing timing', () => {
  const {sessionRecord, session} = fixture();
  session.observations[0].visibleThrough = null;
  delete session.observations[0].replayMarketTime;
  const summary = buildReviewSummary(session);
  assert.equal(summary.sessionId, session.id);
  assert.equal(summary.observations[0].timingKnown, false);
  assert.equal(summary.observations[0].visibleThrough, null);
  assert.equal(summary.exposure.available, true, 'closed intervals have their own timestamps and do not need an open-position cutoff');
});
