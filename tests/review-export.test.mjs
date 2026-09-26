import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildReviewExport} from '../dist/review-export.mjs';
import {nextMinute, readMinuteRange} from '../dist/minute-data.mjs';

const minute = 60;
const quarter = 900;
const start = Date.UTC(2025, 0, 1) / 1000;

function candle(time, open = 100, high = 101, low = 99, close = 100.5, volume = 2) {
  return [time, open, high, low, close, volume];
}
function dataset() {
  const candles = [candle(start - 1800), candle(start - 900), candle(start), candle(start + 900, 100, 200, 50, 150, 40)];
  return {symbol: 'BTCUSDT', interval: 900, range: {start: candles[0][0], end: start + 1800}, candles,
    sources: [{url: 'https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/15m/BTCUSDT-15m-2025-01.zip',
      checksum_url: 'https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/15m/BTCUSDT-15m-2025-01.zip.CHECKSUM',
      sha256: 'a'.repeat(64)}], gaps: []};
}
function activeSession(id, minuteCursorTime, forming15m = null) {
  return {id, symbol: 'BTCUSDT', start: 1, cursor: 1, end: 3, startTime: start,
    minuteCursorTime, currentPrice: minuteCursorTime === null ? undefined : 100.5,
    ...(minuteCursorTime === null ? {} : {forming15m}),
    version: 1, balance: 10000, tf: 604800, trades: [], orderHistory: [],
    pending: null, position: null, notes: 'test note'};
}

function readStoredZip(blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map();
    let offset = 0;
    while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
      const nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
      const size = view.getUint32(offset + 18, true), nameStart = offset + 30;
      const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
      const bodyStart = nameStart + nameLength + extraLength;
      files.set(name, bytes.slice(bodyStart, bodyStart + size));
      offset = bodyStart + size;
    }
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'central directory follows stored local records');
    return files;
  });
}

test('exports only frozen complete minutes and 15m candles; drops events after that round cutoff', async () => {
  const partial = candle(start, 100, 101, 99, 100.5, 2);
  const session = activeSession('round-now', start, partial);
  const audit = {recordingStartedAt: '2025-01-01T00:00:00Z', baseline: true,
    minutes: [partial, candle(start + minute, 100.5, 120, 95, 110, 9)],
    events: [
      {id: 'e1', seq: 1, kind: 'order-submitted', recordedAt: new Date().toISOString(), visibleThrough: start + minute,
        before: {forming15m: partial}, after: {forming15m: partial}, view: {visibleThrough: start + minute, forming15m: partial}, screenshotId: 'shot1'},
      {id: 'e2', seq: 2, kind: 'position-closed', recordedAt: new Date().toISOString(), visibleThrough: start + 300,
        after: {price: 110}, screenshotId: 'shot2'}],
    screenshots: [{id: 'shot1', eventId: 'e1', mimeType: 'image/png', blob: new Blob([Uint8Array.of(1, 2, 3)], {type: 'image/png'})},
      {id: 'shot2', eventId: 'e2', mimeType: 'image/png', blob: new Blob([Uint8Array.of(9)], {type: 'image/png'})}], issues: []};
  const output = await buildReviewExport({current: session, history: [],
    loadDataset: async () => dataset(), readAudit: async () => audit});
  const files = await readStoredZip(output.blob);
  const payload = JSON.parse(new TextDecoder().decode(files.get('完整记录.json')));
  const round = payload.sessions[0];
  assert.equal(payload.version, 2);
  assert.equal(payload.noFutureData, true);
  assert.equal(round.coverage.visibleThrough, start + minute);
  assert.deepEqual(round.market.contextCandles.map(row => row[0]), [start - 1800, start - 900]);
  assert.deepEqual(round.market.minuteCandles, [partial]);
  assert.equal(round.market.forming.candle[4], 100.5);
  assert.equal(round.events.length, 1);
  assert.equal(round.events[0].informationSet.minuteCount, 1);
  assert.equal(round.events[0].informationSet.context15mCount, 2);
  assert.equal(round.auditScreenshots.length, 1);
  assert.ok(files.has(round.auditScreenshots[0].path));
  assert.equal(round.market.sources[0].url, undefined, 'partial month archive URL could expose the rest of its month');
  assert.equal(round.market.sourceManifest.sourceIndex.length, 0);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('文件清单.json')));
  assert.equal(manifest.totalFileCountIncludingManifest, files.size);
  assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.match(output.reportText, /基础资产成交量/);
});

test('backfills missing minutes from a verified UTC day but exports only rows closed by the cutoff', async () => {
  const session = activeSession('round-backfill', start + minute, null);
  const originalFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    const archive = [candle(start), candle(start + minute, 100.5, 120, 95, 110, 9),
      candle(start + 2 * minute, 110, 160, 100, 150, 12)];
    return {ok: true, status: 200, json: async () => ({symbol: 'BTCUSDT', date: '2025-01-01', interval: 60,
      candles: archive, source: {url: 'https://data.binance.vision/private-future-day.zip', checksum_url: 'https://data.binance.vision/private-future-day.zip.CHECKSUM', sha256: 'b'.repeat(64)}})};
  };
  try {
    const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
      readAudit: async () => ({minutes: [], events: [], screenshots: [], issues: []})});
    const files = await readStoredZip(output.blob);
    const payload = JSON.parse(new TextDecoder().decode(files.get('完整记录.json')));
    const round = payload.sessions[0];
    assert.equal(fetches.length, 1);
    assert.deepEqual(round.market.minuteCandles.map(row => row[0]), [start, start + minute]);
    assert.ok(round.coverage.visibleThrough >= start + 2 * minute);
    assert.equal(round.market.minuteCandles.at(-1)[0] + minute, round.coverage.visibleThrough);
    assert.ok(!JSON.stringify(round.market.sourceManifest).includes('private-future-day.zip'),
      'an incomplete day archive URL/hash is not exposed when its remaining rows are future');
  } finally { globalThis.fetch = originalFetch; }
});

test('separate round cutoffs keep shared-date minute data isolated', async () => {
  const current = activeSession('newer-round', start + 2 * minute, null);
  const older = activeSession('older-round', start, null);
  const output = await buildReviewExport({current, history: [{id: 'older-round', session: older}],
    loadDataset: async () => dataset(),
    readAudit: async id => ({minutes: id === 'newer-round' ? [candle(start), candle(start + minute), candle(start + 2 * minute)] : [candle(start)],
      events: [], screenshots: [], issues: []})});
  const payload = JSON.parse(new TextDecoder().decode((await readStoredZip(output.blob)).get('完整记录.json')));
  const byId = new Map(payload.sessions.map(record => [record.id, record]));
  assert.deepEqual(byId.get('older-round').market.minuteCandles.map(row => row[0]), [start]);
  assert.deepEqual(byId.get('newer-round').market.minuteCandles.map(row => row[0]), [start, start + minute, start + 2 * minute]);
  assert.equal(byId.get('older-round').market.minuteCandles.at(-1)[0] + minute, byId.get('older-round').coverage.visibleThrough);
});

test('incomplete old records are retained and explicitly marked instead of discarded', async () => {
  const output = await buildReviewExport({current: null, history: [{id: 'invalid', session: null, corrupt: 'keep me'}],
    loadDataset: async () => dataset(), readAudit: async () => ({})});
  const payload = JSON.parse(new TextDecoder().decode((await readStoredZip(output.blob)).get('完整记录.json')));
  assert.equal(payload.history[0].corrupt, 'keep me');
  assert.equal(payload.sessions[0].coverage.captureCoverageComplete, false);
  assert.match(payload.sessions[0].issues.join('\n'), /缺少可读取的session快照/);
});

test('HTML review book links only the matching trade screenshots and escapes all user text', async () => {
  const session = activeSession('book-round', start + minute, null);
  const dangerous = '</script><img src=x onerror=alert(1)>';
  session.trades = [
    {id: 'trade-A', orderId: 'order-A', side: 1, entry: 100, exit: 102, qty: 1, entryTime: start, exitTime: start + minute,
      entryReason: dangerous, exitReason: '按计划', reason: '止盈', pnl: 2},
    {id: 'trade-B', orderId: 'order-B', side: -1, entry: 102, exit: 101, qty: 1, entryTime: start, exitTime: start + minute,
      entryReason: '第二笔', exitReason: '收盘', reason: '手动平仓', pnl: 1},
  ];
  const image = () => new Blob([Uint8Array.of(137, 80, 78, 71, 1, 2, 3)], {type: 'image/png'});
  const events = [
    {id: 'open-A', seq: 1, kind: 'order-submitted', orderId: 'order-A', recordedAt: new Date().toISOString(), visibleThrough: start + minute,
      before: {trades: session.trades, orderHistory: [{id: 'order-A'}, {id: 'order-B'}]}, after: {pending: {id: 'order-A'}}},
    {id: 'exit-A', seq: 2, kind: 'position-closed', orderId: 'order-A', tradeId: 'trade-A', recordedAt: new Date().toISOString(), visibleThrough: start + minute,
      before: {trades: session.trades, orderHistory: [{id: 'order-A'}, {id: 'order-B'}]}, after: {trades: session.trades}},
    {id: 'open-B', seq: 3, kind: 'order-submitted', orderId: 'order-B', recordedAt: new Date().toISOString(), visibleThrough: start + minute,
      before: {trades: session.trades, orderHistory: [{id: 'order-A'}, {id: 'order-B'}]}, after: {pending: {id: 'order-B'}}},
    {id: 'exit-B', seq: 4, kind: 'position-closed', orderId: 'order-B', tradeId: 'trade-B', recordedAt: new Date().toISOString(), visibleThrough: start + minute,
      before: {trades: session.trades, orderHistory: [{id: 'order-A'}, {id: 'order-B'}]}, after: {trades: session.trades}},
  ];
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({baseline: false, recordingStartedAt: new Date().toISOString(), minutes: [candle(start)], events,
      screenshots: events.map(event => ({id: `shot-${event.id}`, eventId: event.id, mimeType: 'image/png', blob: image()})), issues: []})});
  const files = await readStoredZip(output.blob);
  const html = new TextDecoder().decode(files.get('复盘册.html'));
  assert.match(html, /trade-trade-A/);
  assert.match(html, /trade-trade-B/);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script\b/i, 'offline review HTML requires no executable script');
  const articleA = html.split('<article id="trade-trade-A"')[1].split('</article>')[0];
  const articleB = html.split('<article id="trade-trade-B"')[1].split('</article>')[0];
  assert.match(articleA, /shot-open-A\.png/);
  assert.doesNotMatch(articleA, /shot-open-B\.png/);
  assert.match(articleB, /shot-open-B\.png/);
  assert.doesNotMatch(articleB, /shot-open-A\.png/);
  for (const path of ['截图/current_book-round_shot-open-A.png', '截图/current_book-round_shot-exit-A.png',
    '截图/current_book-round_shot-open-B.png', '截图/current_book-round_shot-exit-B.png']) {
    assert.ok(files.has(path), `HTML image path must resolve inside ZIP: ${path}`);
    assert.ok(html.includes(path));
  }
  const payload = JSON.parse(new TextDecoder().decode(files.get('完整记录.json')));
  assert.equal(payload.metricsBySession.length, 1, 'derived metrics are preserved in the structured package');
  assert.equal(payload.sessions[0].coverage.screenshotCoverage.missingScreenshotCount, 0);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('文件清单.json')));
  assert.ok(manifest.files.some(entry => entry.path === '复盘册.html'));
  const htmlBytes = files.get('复盘册.html');
  const htmlHash = createHash('sha256').update(htmlBytes).digest('hex');
  assert.equal(manifest.files.find(entry => entry.path === '复盘册.html').sha256, htmlHash);
  const shotPath = '截图/current_book-round_shot-open-A.png';
  const shotHash = createHash('sha256').update(files.get(shotPath)).digest('hex');
  assert.equal(manifest.files.find(entry => entry.path === shotPath).sha256, shotHash);
  assert.equal(payload.sessions[0].coverage.captureCoverageComplete, false, 'market data warmup is intentionally incomplete in the tiny fixture');
  assert.equal(payload.sessions[0].coverage.auditComplete, true);
  assert.equal(payload.sessions[0].coverage.screenshotsComplete, true);
});

test('HTML review book orders stages numerically by event sequence, not by event ID or input order', async () => {
  const session = activeSession('ordered-book', start + minute, null);
  session.trades = [{id: 'ordered-trade', orderId: 'ordered-order', side: 1, entry: 100, exit: 101,
    qty: 1, entryTime: start, exitTime: start + minute, pnl: 1}];
  const events = [
    {id: 'event-10', seq: 10, kind: 'position-closed', orderId: 'ordered-order', tradeId: 'ordered-trade',
      recordedAt: '2025-01-01T00:10:00Z', visibleThrough: start + minute},
    {id: 'event-4', seq: 4, kind: 'order-submitted', orderId: 'ordered-order',
      recordedAt: '2025-01-01T00:04:00Z', visibleThrough: start + minute},
  ];
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({minutes: [candle(start)], events, screenshots: [], issues: []})});
  const files = await readStoredZip(output.blob);
  const payload = JSON.parse(new TextDecoder().decode(files.get('完整记录.json')));
  const stages = payload.sessions[0].reviewBook.trades[0].stages;
  assert.deepEqual(stages.map(stage => stage.seq), [4, 10]);
  const html = new TextDecoder().decode(files.get('复盘册.html'));
  assert.ok(html.indexOf('order-submitted') < html.indexOf('position-closed'));
});

test('same stable session id in current and history is counted once; backup retains unknown fields but redacts forming OHLCV', async () => {
  const session = {...activeSession('same-id', start, candle(start, 100, 999, 1, 100, 500)), opaqueV1Field: {keep: 'yes'}};
  session.trades = [{id: 'future-result', entry: 100, exit: 999, exitTime: start + 900, pnl: 999, reason: 'future'}];
  let datasetLoads = 0;
  const output = await buildReviewExport({current: session, history: [{id: 'same-id', session}],
    loadDataset: async () => { datasetLoads += 1; return dataset(); },
    readAudit: async () => ({baseline: true, recordingStartedAt: '2025-01-01T00:00:00Z', minutes: [candle(start)], events: [], screenshots: []})});
  assert.equal(datasetLoads, 1);
  assert.equal(output.payload.sessions.length, 1);
  assert.equal(output.payload.deduplicatedSessions.length, 1);
  assert.equal(output.payload.legacyStateBackup.current.opaqueV1Field.keep, 'yes');
  assert.equal(output.payload.legacyStateBackup.current.forming15m, null);
  assert.ok(output.payload.legacyStateBackup.current.marketDataRedactions.some(item => item.field === 'forming15m'));
  assert.equal(output.payload.legacyStateBackup.current.trades[0].exit, null);
  assert.equal(output.payload.legacyStateBackup.current.trades[0].futureOutcomeRedacted, true);
  assert.equal(output.payload.sessions[0].session.trades[0].exit, null);
  assert.doesNotMatch(JSON.stringify(output.payload.legacyStateBackup), /999|500/);
});

test('as-of snapshots hide future cancellations, protection edits, and exits while restoring known open state', async () => {
  const session = activeSession('asof-protection', start + minute, null);
  session.riskChanges = [{id: 'risk-before', seq: 1, orderId: 'order-x', replayMarketTime: start + 30,
    visibleThrough: start + 30, before: {stop: 80, take: 130}, after: {stop: 90, take: 120}},
    {id: 'risk-pending-before', seq: 2, orderId: 'pending-y', replayMarketTime: start + 30,
      visibleThrough: null, before: {stop: 80, take: 130}, after: {stop: 91, take: 121}}];
  session.accountSnapshots = [{id: 'future-account', seq: 99, visibleThrough: null, replayMarketTime: start + 600, balance: 9000}];
  session.pending = {id: 'pending-y', status: 'pending', placedTime: start, modifiedTime: start + 600, stop: 70, take: 140};
  session.orderHistory = [{id: 'order-x', status: 'cancelled', placedTime: start, cancelledTime: start + 600,
    cancelReason: 'future reason', modifiedTime: start + 600, stop: 70, take: 140}];
  session.trades = [{id: 'trade-x', orderId: 'order-x', positionId: 'position-x', side: 1, entry: 100, qty: 1,
    entryTime: start, entryIndex: 2, exit: 70, exitTime: start + 600, exitIndex: 5, reason: 'future exit', pnl: -30,
    stop: 70, take: 140, initialStop: 90, initialTake: 120, triggerEvidence: {futureExit: true},
    riskChanges: [{id: 'future-risk', replayMarketTime: start + 600}]}];
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({minutes: [candle(start)], events: [], screenshots: [], issues: []})});
  const files = await readStoredZip(output.blob);
  const snapshot = JSON.parse(new TextDecoder().decode(files.get('完整记录.json'))).sessions[0].session;
  assert.equal(snapshot.trades.length, 0);
  assert.equal(snapshot.position.asOfOpenPosition, true);
  assert.equal(snapshot.position.stop, 90);
  assert.equal(snapshot.position.take, 120);
  assert.equal(snapshot.position.pnl, undefined);
  assert.equal(snapshot.position.reason, undefined);
  assert.deepEqual(snapshot.position.riskChanges.map(row => row.id), ['risk-before']);
  assert.equal(snapshot.orderHistory[0].status, 'pending');
  assert.equal(snapshot.orderHistory[0].stop, 90);
  assert.equal(snapshot.orderHistory[0].cancelReason, undefined);
  assert.equal(snapshot.orderHistory[0].cancelledTime, undefined);
  assert.equal(snapshot.position.triggerEvidence, undefined);
  assert.equal(snapshot.pending.stop, 91);
  assert.equal(snapshot.pending.take, 121);
  assert.deepEqual(snapshot.accountSnapshots, [], 'null visibleThrough must not become timestamp zero and bypass replayMarketTime');
});

test('fixed post-exit windows reference only already disclosed minutes and never duplicate candle arrays', async () => {
  const session = activeSession('post-exit-window', start + 900, null);
  session.trades = [{id: 'window-trade', orderId: 'window-order', side: 1, entry: 100, exit: 102, qty: 1,
    entryTime: start, exitTime: start + 120, pnl: 2, fees: 0.08}];
  const minutes = Array.from({length: 16}, (_, index) => candle(start + index * minute, 100, 101, 99, 100.5, 2));
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({minutes, events: [], screenshots: [], issues: []})});
  const files = await readStoredZip(output.blob);
  const round = JSON.parse(new TextDecoder().decode(files.get('完整记录.json'))).sessions[0];
  const window15 = round.session.trades[0].followUpWindows.find(item => item.durationSeconds === 900);
  assert.equal(window15.status, 'pending');
  assert.equal(window15.dataRef, 'session.market.minuteCandles');
  assert.equal(window15.expectedMinuteRows, 15);
  const observedWindow = round.market.minuteCandles.filter(row => row[0] >= start + 120 && row[0] + 60 <= start + 1020);
  assert.equal(window15.availableMinuteRows, observedWindow.length);
  assert.equal(Object.hasOwn(window15, 'candles'), false);
  assert.ok(round.market.minuteCandles.every(row => row[0] + 60 <= round.coverage.visibleThrough));
  assert.equal(window15.observedSummary.volumeBase, observedWindow.reduce((sum, row) => sum + row[5], 0));
});

test('missing key-action screenshot is named and prevents a complete screenshot claim', async () => {
  const session = activeSession('missing-shot', start, null);
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({baseline: false, recordingStartedAt: '2025-01-01T00:00:00Z', minutes: [candle(start)],
      events: [{id: 'open-without-shot', seq: 1, kind: 'order-submitted', orderId: 'missing-order',
        recordedAt: '2025-01-01T00:00:00Z', visibleThrough: start + minute}], screenshots: [], issues: []})});
  const coverage = output.payload.sessions[0].coverage;
  assert.equal(coverage.screenshotsComplete, false);
  assert.equal(coverage.screenshotCoverage.missingScreenshotCount, 1);
  assert.deepEqual(coverage.screenshotCoverage.missingEventIds, ['open-without-shot']);
  assert.ok(output.issues.some(item => item.message.includes('没有可验证的截图附件')));
});

test('evidence quality requires a plan per order, ledger endpoint reconciliation, and captures trigger/observation events', async () => {
  const session = activeSession('evidence-quality', start + minute, null);
  session.engineVersion = 'isolated-v1';
  session.initialBalance = 10000;
  session.balance = 10010;
  session.orders = [{id: 'planned-order', planId: 'plan-1'}, {id: 'unplanned-order'}];
  session.reviewPlans = [{planId: 'plan-1', snapshotId: 'plan-shot', visibleThrough: start + minute}];
  session.modelConfigs = [{modelConfigId: 'model-1'}];
  session.ledger = [
    {id: 'ledger-1', seq: 1, type: 'initial-balance', baselineBalance: 10000, cashDelta: 0,
      balanceAfter: 10000, equityAfter: 10000, usedMarginAfter: 0},
    {id: 'ledger-2', seq: 2, type: 'entry-fee', cashDelta: 0, balanceAfter: 10000,
      equityAfter: 10000, usedMarginAfter: 0},
  ];
  const events = [
    {id: 'trigger-event', seq: 1, kind: 'position-triggered', snapshotId: 'trigger-snap', visibleThrough: start + minute, view: {}},
    {id: 'observation-event', seq: 2, kind: 'observation-recorded', snapshotId: 'observation-snap', visibleThrough: start + minute, view: {}},
  ];
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({recordingStartedAt: '2025-01-01T00:00:00Z', baseline: false,
      minutes: [candle(start)], events, screenshots: [], issues: []})});
  const coverage = output.payload.sessions[0].coverage;
  assert.equal(coverage.evidenceComplete, false);
  assert.equal(coverage.evidenceCoverage.plans.missingReferences, 1);
  assert.equal(coverage.evidenceCoverage.ledger.status, 'incomplete', 'tail ledger balance must reconcile to session balance');
  assert.equal(coverage.screenshotCoverage.expectedKeyActionCount, 2);
  assert.deepEqual(coverage.screenshotCoverage.missingEventIds, ['trigger-event', 'observation-event']);
});

test('exporter passes explicit round model evidence, as-of chart bar, gap coverage, and metrics into the real report', async () => {
  const session = activeSession('model-round', start + minute, null);
  session.initialBalance = 10000;
  session.balance = 10001.92;
  session.simulationModel = {id: 'isolated-v1', marketProduct: 'spot', executionModel: 'custom-isolated-leverage',
    feeRate: 0.0004, slippageRate: 0.0002, maintenanceMarginRate: 0.005,
    sizeBudgetSemantics: 'margin+entry-fee', recordedAt: '2025-01-01T00:00:00Z'};
  session.trades = [{id: 'model-trade', orderId: 'model-order', side: 1, entry: 100, exit: 102, qty: 1,
    entryFee: 0.04, fees: 0.08, pnl: 1.92, entryTime: start, exitTime: start + 120,
    entryReason: '验证', exitReason: '完成', reason: '手动平仓', marginMode: 'isolated-v1', leverage: 1, margin: 100}];
  const image = new Blob([Uint8Array.of(1, 2, 3)], {type: 'image/png'});
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({baseline: false, recordingStartedAt: '2025-01-01T00:00:00Z',
      minutes: [candle(start), candle(start + minute, 100.5, 120, 95, 110, 9)],
      events: [{id: 'model-event', seq: 1, kind: 'order-submitted', orderId: 'model-order', recordedAt: '2025-01-01T00:00:01Z',
        visibleThrough: start + minute, view: {visibleThrough: start + minute, currentBar: {time: start, interval: quarter,
          open: 100, high: 101, low: 99, close: 100.5, volume: 2, complete: false}}}],
      screenshots: [{id: 'model-shot', eventId: 'model-event', mimeType: 'image/png', blob: image}], issues: []})});
  const record = output.payload.sessions[0];
  assert.equal(record.modelEvidence.applicableToSession, true);
  assert.equal(record.modelEvidence.feeRate, 0.0004);
  assert.equal(output.payload.source.feeRate, 0.0004);
  assert.equal(record.events[0].view.currentBar.volume, 2);
  assert.equal(record.events[0].view.currentBar.complete, false);
  assert.equal(record.coverage.marketComplete, false, 'fixture lacks the full requested 365-day warmup and must be marked incomplete');
  assert.ok(record.coverage.warmupMissingBars > 0);
  assert.equal(output.metricsBySession[0].equityCurveAvailable, true);
  assert.equal(output.metricsBySession[0].initialBalance, 10000);
  assert.equal(output.metricsBySession[0].trades[0].anchor, 'trade-model-trade');
  assert.match(output.reportText, /trade-model-trade/);
});

test('nested immutable model configs override legacy flat rates and identify the actual referenced config', async () => {
  const session = activeSession('nested-model', start + minute, null);
  session.simulationModel = {feeRate: 0.09, slippageRate: 0.08, maintenanceMarginRate: 0.07};
  session.modelConfigId = 'baseline';
  session.modelConfigs = [
    {modelConfigId: 'cfg-used', engineVersion: 'engine-v2', productType: 'spot-market-data',
      executionModel: 'local-isolated-paper-simulator', fee: {openRate: 0.001, closeRate: 0.002},
      slippage: {rate: 0.003}, margin: {maintenanceRate: 0.01}, effectiveFrom: {recordedAt: '2025-01-01T00:00:00Z', replayMarketTime: start}, baselineOnly: false},
    {modelConfigId: 'baseline', engineVersion: 'legacy-unversioned', fee: {openRate: 0.09, closeRate: 0.09},
      slippage: {rate: 0.08}, margin: {maintenanceRate: 0.07}, baselineOnly: true},
  ];
  session.orders = [{id: 'nested-order', modelConfigId: 'cfg-used'}];
  session.fills = [{id: 'nested-fill', orderId: 'nested-order', side: 'entry', modelConfigId: 'cfg-used',
    time: start, price: 100, qty: 1, fee: 0.2}];
  session.trades = [{id: 'nested-trade', orderId: 'nested-order', modelConfigId: 'cfg-used', side: 1,
    entry: 100, exit: 101, qty: 1, entryTime: start, exitTime: start + minute, pnl: 0.6, fees: 0.4,
    initialStop: 99, initialRiskR0: 1, marginMode: 'isolated-v1'}];
  const output = await buildReviewExport({current: session, history: [], loadDataset: async () => dataset(),
    readAudit: async () => ({minutes: [candle(start), candle(start + minute)], events: [], screenshots: [], issues: []})});
  const record = output.payload.sessions[0];
  assert.equal(record.modelEvidence.modelConfigId, 'cfg-used');
  assert.equal(record.modelEvidence.feeRate, 0.002);
  assert.equal(record.modelEvidence.slippageRate, 0.003);
  assert.notEqual(record.modelEvidence.feeRate, session.simulationModel.feeRate);
  assert.equal(output.metricsBySession[0].trades[0].modelConfigId, 'cfg-used');
});

test('range export shares validated network work without poisoning nextMinute candle cache', async () => {
  const day = Date.UTC(2025, 10, 3) / 1000;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return {ok: true, status: 200, json: async () => ({symbol: 'ETHUSDT', date: '2025-11-03', interval: 60,
      candles: [candle(day), candle(day + minute, 101, 102, 100, 101.5, 5)],
      source: {url: 'https://data.binance.vision/1m.zip', checksum_url: 'https://data.binance.vision/1m.zip.CHECKSUM', sha256: 'c'.repeat(64)}})};
  };
  try {
    const rangeDayCache = new Map();
    const [first, range] = await Promise.all([
      nextMinute('ETHUSDT', day - 1),
      readMinuteRange('ETHUSDT', day, day + 2 * minute, {dayCache: rangeDayCache})
    ]);
    assert.deepEqual(first, candle(day));
    assert.deepEqual(range.candles, [candle(day), candle(day + minute, 101, 102, 100, 101.5, 5)]);
    assert.deepEqual(await nextMinute('ETHUSDT', day), candle(day + minute, 101, 102, 100, 101.5, 5));
    assert.equal(calls, 1);
    assert.ok(Array.isArray(rangeDayCache.get(`ETHUSDT/2025-11-03`).candles));
  } finally { globalThis.fetch = originalFetch; }
});
