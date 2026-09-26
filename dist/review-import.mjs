const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 160 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 4096;
const utf8 = new TextDecoder('utf-8', {fatal: true});

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let i = 0; i < 8; i += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持SHA-256校验。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function checkedPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('ZIP含不安全文件路径。');
  return path;
}
function bytesFrom(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}
async function inputBytes(input) {
  const bytes = bytesFrom(input);
  if (bytes) return bytes;
  if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  throw new TypeError('请选择JSON或本工具生成的ZIP复盘包。');
}
function parseJson(bytes, label) {
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`${label}超过安全大小限制。`);
  try { return JSON.parse(utf8.decode(bytes)); }
  catch { throw new Error(`${label}不是有效UTF-8 JSON。`); }
}
function numericTime(value) {
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
  const n = typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) / 1000 : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function validCandle(row, interval) {
  if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isFinite)) return false;
  const [time, open, high, low, close, volume] = row;
  return Number.isInteger(time) && time >= 0 && time % interval === 0 && Math.min(open, high, low, close) > 0 && volume >= 0 &&
    high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
}
function validateRows(rows, interval, cutoff, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}行情数组缺失。`);
  let previous = -1;
  for (const row of rows) {
    if (!validCandle(row, interval) || row[0] <= previous) throw new Error(`${label}行情OHLCV、间隔或排序无效。`);
    if (cutoff !== null && row[0] + interval > cutoff) throw new Error(`${label}含超过该轮visibleThrough的未收盘行情。`);
    previous = row[0];
  }
}
function clone(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function readStoredZip(bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('复盘ZIP超过256MiB限制。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i -= 1) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP中央目录缺失或文件不完整。');
  const count = view.getUint16(eocd + 10, true), centralSize = view.getUint32(eocd + 12, true), centralStart = view.getUint32(eocd + 16, true);
  if (count > MAX_FILES || count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff || centralStart + centralSize > eocd)
    throw new Error('ZIP目录大小或ZIP64格式不受支持。');
  const files = new Map();
  let cursor = centralStart;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP中央目录格式无效。');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true), plainSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 1 || flags & 8 || method !== 0 || compressedSize !== plainSize || plainSize === 0xffffffff || localOffset === 0xffffffff)
      throw new Error('仅支持本工具生成的未压缩ZIP；加密、压缩、数据描述符或ZIP64均拒绝。');
    const name = checkedPath(utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    if (files.has(name)) throw new Error(`ZIP存在重复路径：${name}`);
    const local = localOffset;
    if (local + 30 > centralStart || view.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP本地文件头无效。');
    const localFlags = view.getUint16(local + 6, true), localMethod = view.getUint16(local + 8, true);
    const localCrc = view.getUint32(local + 14, true), localSize = view.getUint32(local + 18, true), localPlain = view.getUint32(local + 22, true);
    const localName = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localName + localExtra, dataEnd = dataStart + plainSize;
    const actualLocalName = utf8.decode(bytes.subarray(local + 30, local + 30 + localName));
    if (actualLocalName !== name || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localSize !== plainSize || localPlain !== plainSize || dataEnd > centralStart)
      throw new Error(`ZIP本地/中央目录信息不一致：${name}`);
    const body = bytes.slice(dataStart, dataEnd);
    if (crc32(body) !== expectedCrc) throw new Error(`ZIP CRC校验失败：${name}`);
    files.set(name, body);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralStart + centralSize) throw new Error('ZIP中央目录长度与目录记录不符。');
  return files;
}

function asLegacyArchives(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !('current' in document) && !Array.isArray(document.history)) throw new Error('JSON不是支持的V1 current/history备份。');
  const items = [];
  const topLevelUnknown = Object.fromEntries(Object.entries(document).filter(([key]) => !['current', 'history'].includes(key)));
  if (document.current && typeof document.current === 'object') items.push({id: document.current.id, session: document.current, slot: 'current'});
  for (const [index, item] of (Array.isArray(document.history) ? document.history : []).entries()) {
    if (item?.session && typeof item.session === 'object') items.push({id: item.id ?? item.session.id, session: item.session, slot: `history-${index}`, rawRecord: item});
    else if (item && typeof item === 'object' && item.id && item.symbol) items.push({id: item.id, session: item, slot: `history-${index}`});
  }
  return items.map(item => {
    if (!item.session || typeof item.session.id !== 'string' || typeof item.session.symbol !== 'string') return null;
    const id = item.session.id;
    return {session: clone(item.session), events: [], screenshots: [], minutes: [], plans: [], snapshots: [], drawingVersions: [],
      fills: Array.isArray(item.session.fills) ? clone(item.session.fills) : [],
      ledger: Array.isArray(item.session.ledger) ? clone(item.session.ledger) : [],
      sourceMetadata: {format: 'V1 JSON state backup', slot: item.slot, rawRecord: item.rawRecord ?? null,
        topLevelUnknown: clone(topLevelUnknown), unknownFieldsPreserved: true},
      coverage: {complete: false, reason: 'V1状态备份不包含可核验的完整事件/行情证据；不补造。'}, issues: ['旧格式状态备份不是完整复盘证据包。'],
      executionDisabled: true, origin: 'v1-import', contentHash: null};
  }).filter(Boolean);
}

function validateZipPayload(payload) {
  if (!payload || payload.schemaVersion !== '2.0.0' || payload.noFutureData !== true || !Array.isArray(payload.sessions))
    throw new Error('ZIP不是本工具2.0格式，或缺少noFutureData声明。');
  const archives = [], ids = new Set();
  for (const record of payload.sessions) {
    const session = record?.session, id = session?.id ?? record?.id;
    if (!record || !session || typeof id !== 'string' || !id || ids.has(id) || !['BTCUSDT', 'ETHUSDT'].includes(session.symbol))
      throw new Error('ZIP会话身份缺失、标的无效或sessionId重复。');
    ids.add(id);
    const cutoff = numericTime(record.coverage?.visibleThrough);
    if (cutoff === null) throw new Error(`会话${id}缺少可验证visibleThrough。`);
    validateRows(record.market?.contextCandles, 900, cutoff, `${id} 15m`);
    validateRows(record.market?.minuteCandles, 60, cutoff, `${id} 1m`);
    const eventIds = new Set(), sequences = new Set();
    for (const event of record.events ?? []) {
      if (!event || typeof event.id !== 'string' || !Number.isInteger(event.seq) || event.seq < 1 || eventIds.has(event.id) || sequences.has(event.seq))
        throw new Error(`会话${id}事件ID/序号重复或无效。`);
      if (event.sessionId != null && String(event.sessionId) !== String(id)) throw new Error(`会话${id}包含归属到其他session的事件。`);
      eventIds.add(event.id); sequences.add(event.seq);
      const eventCutoff = numericTime(event.visibleThrough);
      if (eventCutoff !== null && eventCutoff > cutoff) throw new Error(`会话${id}事件${event.id}越过轮次披露边界。`);
      for (const stamp of [event.replayMarketTime, event.visibleThrough]) {
        const value = numericTime(stamp);
        if (stamp != null && value === null) throw new Error(`会话${id}事件${event.id}时间字段无效。`);
      }
    }
    const screenshots = record.auditScreenshots ?? [];
    const screenshotIds = new Set();
    for (const shot of screenshots) {
      if (!shot || typeof shot.id !== 'string' || screenshotIds.has(shot.id) || !checkedPath(shot.path) || !eventIds.has(shot.eventId))
        throw new Error(`会话${id}截图索引无效或事件引用缺失。`);
      screenshotIds.add(shot.id);
    }
    const checkUnique = (collection, label, keyOf = item => item?.id) => {
      const values = Array.isArray(collection) ? collection : [];
      const refs = new Set();
      for (const item of values) {
        const key = item && keyOf(item);
        if (!item || typeof key !== 'string' || !key || refs.has(key)) throw new Error(`会话${id}${label}ID缺失或重复。`);
        refs.add(key);
      }
      return refs;
    };
    const orderIds = checkUnique(session.orders, '订单');
    const tradeIds = checkUnique(session.trades, '交易');
    const fillIds = checkUnique(session.fills, '成交');
    checkUnique(session.ledger, '账本');
    const planKeys = checkUnique(session.reviewPlans, '计划', item =>
      typeof item.planId === 'string' && Number.isInteger(item.version) ? `${item.planId}@${item.version}` : null);
    checkUnique(session.modelConfigs, '模型配置', item => item?.modelConfigId);
    checkUnique(session.theses, '想法', item => item?.thesisId);
    checkUnique(session.observations, '观察', item => item?.observationId);
    const snapshotIds = new Set([
      ...(record.events ?? []).map(event => event.snapshotId),
      ...(session.accountSnapshots ?? []).map(snapshot => snapshot.id),
      ...(session.snapshots ?? []).map(snapshot => snapshot.id),
    ].filter(value => typeof value === 'string'));
    for (const plan of session.reviewPlans ?? []) {
      const time = numericTime(plan.visibleThrough);
      if (time === null || time > cutoff) throw new Error(`会话${id}计划披露时间缺失或越界。`);
      if (plan.sessionId != null && String(plan.sessionId) !== String(id)) throw new Error(`会话${id}计划归属不一致。`);
      if (plan.snapshotId && !snapshotIds.has(plan.snapshotId)) throw new Error(`会话${id}计划快照引用缺失。`);
      const parentVersion = Number.isInteger(plan.parentVersion) ? plan.parentVersion : plan.version - 1;
      if (plan.parentPlanId && !planKeys.has(`${plan.parentPlanId}@${parentVersion}`))
        throw new Error(`会话${id}计划版本链引用缺失。`);
    }
    for (const fill of session.fills ?? []) {
      if (!['entry', 'exit'].includes(fill.side) || ![fill.price, fill.qty, fill.notional, fill.fee].every(Number.isFinite) ||
          fill.price <= 0 || fill.qty <= 0 || fill.notional <= 0 || fill.fee < 0 || fill.orderId && session.orders?.length && !orderIds.has(fill.orderId) ||
          fill.tradeId && fill.side === 'exit' && !tradeIds.has(fill.tradeId)) throw new Error(`会話${id}成交字段或订单/交易引用无效。`);
    }
    for (const trade of session.trades ?? []) {
      if (trade.entryFillId && (!fillIds.has(trade.entryFillId) || session.fills.find(fill => fill.id === trade.entryFillId)?.side !== 'entry') ||
          trade.exitFillId && (!fillIds.has(trade.exitFillId) || session.fills.find(fill => fill.id === trade.exitFillId)?.side !== 'exit'))
        throw new Error(`会话${id}交易的entry/exit成交引用无效。`);
    }
    for (const observation of session.observations ?? []) {
      if (observation.sessionId != null && String(observation.sessionId) !== String(id)) throw new Error(`会话${id}观察归属不一致。`);
      if (observation.visibleThrough != null && (numericTime(observation.visibleThrough) === null || numericTime(observation.visibleThrough) > cutoff))
        throw new Error(`会话${id}观察披露时间越界或无效。`);
      if (observation.snapshotId && !snapshotIds.has(observation.snapshotId)) throw new Error(`会话${id}观察快照引用缺失。`);
      if (observation.thesisId && !(session.theses ?? []).some(thesis => thesis.thesisId === observation.thesisId))
        throw new Error(`会话${id}观察关联的thesis缺失。`);
    }
    for (const row of session.ledger ?? []) {
      if (!Number.isInteger(row.seq) || !Number.isFinite(row.cashDelta) || !Number.isFinite(row.balanceAfter) ||
          row.fillId && !fillIds.has(row.fillId)) throw new Error(`会话${id}账本序号、数值或成交引用无效。`);
    }
    for (const trade of session.trades ?? []) {
      for (const value of [trade.entry, trade.exit, trade.qty, trade.pnl, trade.fees])
        if (value != null && !Number.isFinite(value)) throw new Error(`会话${id}交易含非有限数值。`);
      for (const value of [trade.entryTime, trade.exitTime]) {
        const time = numericTime(value);
        if (value != null && (time === null || time > cutoff)) throw new Error(`会话${id}交易时间越界或无效。`);
      }
    }
    archives.push({session: clone(session), events: clone(record.events ?? []), screenshots: [],
      minutes: clone(record.market.minuteCandles), plans: clone(session.reviewPlans ?? []), snapshots: [],
      drawingVersions: clone(session.drawingVersions ?? []), fills: clone(session.fills ?? []), ledger: clone(session.ledger ?? []),
      sourceMetadata: {market: clone(record.market), sourceManifest: clone(record.market.sourceManifest ?? null),
        modelEvidence: clone(record.modelEvidence ?? null), metrics: clone(payload.metricsBySession?.find(item => item.sessionId === id) ?? null)},
      coverage: clone(record.coverage), issues: clone(record.issues ?? []), executionDisabled: true,
      origin: 'review-zip-import', archiveScreenshotRefs: clone(screenshots), contentHash: null});
  }
  return archives;
}

/** Parse a V1 state JSON backup or this application's self-contained, stored-ZIP V2 package.
 * Returned archives are inert history records; callers must route them to IndexedDB archival import.
 */
export async function parseReviewImport(input) {
  const bytes = await inputBytes(input);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('导入文件超过256MiB限制。');
  const signature = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) : 0;
  if (signature !== 0x04034b50) {
    const document = parseJson(bytes, 'JSON备份');
    const archives = asLegacyArchives(document);
    for (const archive of archives) archive.contentHash = await sha256(new TextEncoder().encode(stableStringify({
      session: archive.session, sourceMetadata: archive.sourceMetadata,
    })));
    return {format: 'v1-json', archives, issues: ['V1 JSON仅作为状态归档导入；没有完整录制证据的字段保持未知。'], noReplay: true};
  }
  const files = await readStoredZip(bytes);
  const manifestBytes = files.get('文件清单.json');
  const jsonBytes = files.get('完整记录.json');
  if (!manifestBytes || !jsonBytes) throw new Error('ZIP缺少文件清单.json或完整记录.json。');
  const manifest = parseJson(manifestBytes, '文件清单');
  if (manifest.version !== 1 || !manifest.selfHashExcluded || !Array.isArray(manifest.files) || manifest.files.length !== files.size - 1)
    throw new Error('ZIP清单格式或文件总数无效。');
  const listed = new Set();
  for (const entry of manifest.files) {
    const path = checkedPath(entry?.path);
    if (listed.has(path) || path === '文件清单.json') throw new Error('ZIP清单含重复或非法路径。');
    listed.add(path);
    const body = files.get(path);
    if (!body || body.length !== entry.bytes || await sha256(body) !== entry.sha256) throw new Error(`ZIP文件SHA-256或大小校验失败：${path}`);
    if (path.startsWith('截图/') && body.length > MAX_SCREENSHOT_BYTES) throw new Error(`截图超过20MiB限制：${path}`);
  }
  for (const path of files.keys()) if (path !== '文件清单.json' && !listed.has(path)) throw new Error(`ZIP含有清单外文件：${path}`);
  if (manifest.totalFileCountIncludingManifest !== files.size) throw new Error('ZIP清单声明的文件数量不一致。');
  const payload = parseJson(jsonBytes, '完整记录');
  const archives = validateZipPayload(payload);
  for (const archive of archives) {
    for (const shot of archive.archiveScreenshotRefs) {
      const body = files.get(shot.path);
      if (!body) throw new Error(`截图文件缺失：${shot.path}`);
      if (shot.mimeType !== 'image/png' || !shot.path.toLowerCase().endsWith('.png') || body.length < 8 ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => body[index] === value))
        throw new Error(`截图格式不是受支持的PNG：${shot.path}`);
      const blob = new Blob([body], {type: shot.mimeType || 'application/octet-stream'});
      archive.screenshots.push({id: shot.id, eventId: shot.eventId, mimeType: shot.mimeType || blob.type,
        captureType: shot.captureType ?? null, blob});
    }
    delete archive.archiveScreenshotRefs;
  }
  const hashBySession = new Map((payload.sessions ?? []).map(record => [record.session.id, record]));
  for (const archive of archives) {
    const record = hashBySession.get(archive.session.id);
    const screenshotHashes = [];
    for (const shot of record?.auditScreenshots ?? []) {
      const body = files.get(shot.path);
      screenshotHashes.push({id: shot.id, eventId: shot.eventId, captureType: shot.captureType ?? null,
        mimeType: shot.mimeType ?? null, sha256: await sha256(body)});
    }
    const canonicalSession = clone(archive.session);
    if (canonicalSession && typeof canonicalSession === 'object') delete canonicalSession.reviewBook;
    const canonicalEvidence = {
      session: canonicalSession,
      events: archive.events,
      market: {contextCandles: record?.market?.contextCandles ?? [], minuteCandles: record?.market?.minuteCandles ?? []},
      screenshots: screenshotHashes,
    };
    archive.contentHash = await sha256(new TextEncoder().encode(stableStringify(canonicalEvidence)));
  }
  const contentHash = await sha256(new TextEncoder().encode(stableStringify(archives.map(item => [item.session.id, item.contentHash]))));
  return {format: 'review-zip-v2', archives, issues: [], noReplay: true, contentHash};
}

export function classifyReviewImport(archive, existing = []) {
  const prior = existing.find(item => item?.session?.id === archive?.session?.id || item?.sessionId === archive?.session?.id);
  if (!prior) return {status: 'new'};
  if (archive.contentHash && prior.importContentHash === archive.contentHash) return {status: 'duplicate', sessionId: archive.session.id};
  return {status: 'conflict', sessionId: archive.session.id, reason: '已有同ID练习；不会覆盖，需用户自行保留现有或另行处理。'};
}
