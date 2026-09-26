import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewExport} from '../dist/review-export.mjs';
import {parseReviewImport, classifyReviewImport} from '../dist/review-import.mjs';

const start = Date.UTC(2025, 0, 1) / 1000;
const candle = time => [time, 100, 101, 99, 100.5, 2];
function data() {
  const candles = [candle(start - 1800), candle(start - 900), candle(start), candle(start + 900)];
  return {symbol: 'BTCUSDT', interval: 900, range: {start: candles[0][0], end: start + 1800}, candles, sources: [], gaps: []};
}
function session() {
  return {id: 'import-round', symbol: 'BTCUSDT', start: 1, cursor: 1, end: 3, startTime: start,
    minuteCursorTime: start, currentPrice: 100.5, forming15m: candle(start), tf: 900,
    trades: [], orders: [], fills: [], ledger: [], orderHistory: [], pending: null, position: null,
    balance: 10000, initialBalance: 10000, notes: '理由 <img onerror=alert(1)>'};
}
async function makeZip() {
  const practice = session();
  return buildReviewExport({current: practice, history: [], loadDataset: async () => data(),
    readAudit: async () => ({minutes: [candle(start)], events: [], screenshots: [], issues: [], baseline: false,
      recordingStartedAt: '2025-01-01T00:00:00Z'})});
}

test('imports self-contained V2 ZIP as inert archive with validated market cutoff and original fields', async () => {
  const built = await makeZip();
  const parsed = await parseReviewImport(built.blob);
  assert.equal(parsed.format, 'review-zip-v2');
  assert.equal(parsed.noReplay, true);
  assert.equal(parsed.archives.length, 1);
  const archive = parsed.archives[0];
  assert.equal(archive.executionDisabled, true);
  assert.equal(archive.session.notes, '理由 <img onerror=alert(1)>');
  assert.deepEqual(archive.minutes, [candle(start)]);
  assert.equal(archive.screenshots.length, 0);
  assert.ok(archive.contentHash);
});

test('review plan identity uses planId plus version and requires a resolvable snapshot', async () => {
  const practice = session();
  practice.reviewPlans = [{planId: 'plan-1', version: 1, visibleThrough: start + 60, snapshotId: 'snapshot-1', rawText: 'setup'}];
  const built = await buildReviewExport({current: practice, history: [], loadDataset: async () => data(),
    readAudit: async () => ({minutes: [candle(start)], events: [{id: 'event-1', seq: 1, sessionId: practice.id,
      snapshotId: 'snapshot-1', visibleThrough: start + 60, kind: 'order-submitted'}], screenshots: [], issues: []})});
  const parsed = await parseReviewImport(built.blob);
  assert.deepEqual(parsed.archives[0].plans.map(plan => [plan.planId, plan.version]), [['plan-1', 1]]);
  const broken = await buildReviewExport({current: {...practice, reviewPlans: [{...practice.reviewPlans[0], snapshotId: 'missing'}]}, history: [],
    loadDataset: async () => data(), readAudit: async () => ({minutes: [candle(start)], events: [], screenshots: [], issues: []})});
  await assert.rejects(() => parseReviewImport(broken.blob), /快照引用缺失/);
});

test('per-session content hash is stable across exports with different package timestamps', async () => {
  const first = await parseReviewImport((await makeZip()).blob);
  await new Promise(resolve => setTimeout(resolve, 3));
  const second = await parseReviewImport((await makeZip()).blob);
  assert.equal(first.archives[0].contentHash, second.archives[0].contentHash);
  assert.equal(classifyReviewImport(second.archives[0], [{sessionId: first.archives[0].session.id,
    importContentHash: first.archives[0].contentHash}]).status, 'duplicate');
});

test('an imported archive can be exported again entirely from its IndexedDB evidence without market fetching', async () => {
  const original = await makeZip();
  const imported = (await parseReviewImport(original.blob)).archives[0];
  let datasetCalls = 0;
  const rebuilt = await buildReviewExport({current: null, history: [{id: imported.session.id, session: imported.session, imported: true}],
    loadDataset: async () => { datasetCalls += 1; throw new Error('offline dataset must not be requested'); },
    readAudit: async () => ({archivedSession: imported.session, sourceMetadata: imported.sourceMetadata,
      coverage: imported.coverage, minutes: imported.minutes, events: imported.events, screenshots: imported.screenshots,
      recordingStartedAt: imported.coverage?.auditRecordingStartedAt ?? null,
      baseline: imported.coverage?.auditBaseline ?? imported.coverage?.baseline ?? false, issues: []})});
  assert.equal(datasetCalls, 0);
  const archiveAgain = (await parseReviewImport(rebuilt.blob)).archives[0];
  assert.deepEqual(archiveAgain.minutes, imported.minutes);
  assert.deepEqual(archiveAgain.sourceMetadata.market.contextCandles, imported.sourceMetadata.market.contextCandles);
  assert.equal(archiveAgain.session.id, imported.session.id);
});

test('V1 JSON imports all unique snapshots as inert archives and keeps unknown fields', async () => {
  const document = {version: 1, extraTopLevel: {keep: true}, current: session(), history: [
    {id: 'old', session: {...session(), id: 'old'}, extra: 'keep-record'},
    {id: 'old', session: {...session(), id: 'old'}, extra: 'duplicate'},
  ]};
  const parsed = await parseReviewImport(new Blob([JSON.stringify(document)], {type: 'application/json'}));
  assert.equal(parsed.format, 'v1-json');
  assert.equal(parsed.archives.length, 3);
  assert.equal(parsed.archives[0].executionDisabled, true);
  assert.equal(parsed.archives[0].session.notes, session().notes);
  assert.equal(parsed.archives[1].sourceMetadata.rawRecord.extra, 'keep-record');
  assert.deepEqual(parsed.archives[0].sourceMetadata.topLevelUnknown.extraTopLevel, {keep: true});
  assert.equal(classifyReviewImport(parsed.archives[0], []).status, 'new');
  assert.equal(classifyReviewImport(parsed.archives[0], [{sessionId: parsed.archives[0].session.id,
    importContentHash: parsed.archives[0].contentHash}]).status, 'duplicate');
});

test('rejects V2 ZIP content modified after manifest SHA/CRC were generated', async () => {
  const built = await makeZip();
  const bytes = new Uint8Array(await built.blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 0, changed = false;
  while (offset + 30 < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 18, true), body = offset + 30 + nameLength + extra;
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (name === '完整记录.json' && size) { bytes[body + Math.floor(size / 2)] ^= 1; changed = true; break; }
    offset = body + size;
  }
  assert.equal(changed, true);
  await assert.rejects(() => parseReviewImport(bytes), /CRC校验失败/);
});
