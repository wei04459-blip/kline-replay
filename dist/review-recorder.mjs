const DB_NAME = 'kline-replay-review-v1';
const DB_VERSION = 2;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('复盘资料读取失败'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('复盘资料保存失败'));
    transaction.onabort = () => reject(transaction.error || new Error('复盘资料保存已取消'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('此浏览器不支持本地过程记录'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', {keyPath: 'sessionId'});
      const events = db.objectStoreNames.contains('events') ? request.transaction.objectStore('events') : db.createObjectStore('events', {keyPath: ['sessionId', 'seq']});
      const minutes = db.objectStoreNames.contains('minutes') ? request.transaction.objectStore('minutes') : db.createObjectStore('minutes', {keyPath: ['sessionId', 'time']});
      const screenshots = db.objectStoreNames.contains('screenshots') ? request.transaction.objectStore('screenshots') : db.createObjectStore('screenshots', {keyPath: 'id'});
      for (const store of [events, minutes, screenshots]) if (!store.indexNames.contains('sessionId')) store.createIndex('sessionId', 'sessionId', {unique: false});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地复盘资料库'));
    request.onblocked = () => reject(new Error('本地复盘资料库正被旧页面占用，请关闭旧页面后重试'));
  });
}

function jsonClone(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function projection(session) {
  // Callers capture this immediately before mutating the live session. Detach
  // nested records here as well as in observe(), otherwise in-place engine
  // updates rewrite the caller's "before" snapshot before it is queued.
  return jsonClone({
    symbol: session.symbol,
    cursor: session.cursor,
    minuteCursorTime: session.minuteCursorTime ?? null,
    forming15m: session.forming15m ?? null,
    currentPrice: session.currentPrice ?? null,
    tf: session.tf,
    ma: !!session.ma,
    ma10: !!session.ma10,
    blind: !!session.blind,
    volume: session.volume !== false,
    sizePercent: session.sizePercent ?? null,
    leverage: session.leverage ?? null,
    orderType: session.selectedOrderType ?? session.draftPlan?.orderType ?? null,
    speed: session.speed ?? null,
    draftPlan: session.draftPlan ?? null,
    pending: session.pending ?? null,
    position: session.position ?? null,
    orderHistory: session.orderHistory ?? [],
    trades: session.trades ?? [],
    drawings: session.drawings ?? [],
    notes: session.notes ?? '',
    simulationModel: session.simulationModel ?? null
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function same(a, b) { return stable(a) === stable(b); }

function inferredKind(before, after) {
  if (!before) return null;
  if (!same(before.drawings, after.drawings)) {
    const oldIds = new Set((before.drawings || []).map(x => x?.id));
    const newIds = new Set((after.drawings || []).map(x => x?.id));
    if ([...newIds].some(id => !oldIds.has(id))) return 'drawing-created';
    if ([...oldIds].some(id => !newIds.has(id))) return 'drawing-deleted';
    return 'drawing-modified';
  }
  if (!same(before.position, after.position)) {
    if (!before.position && after.position) return 'position-opened';
    if (before.position && !after.position) return 'position-closed';
    if (before.position && after.position) return 'protection-changed';
  }
  if (!same(before.pending, after.pending)) {
    if (!before.pending && after.pending) return 'order-submitted';
    if (before.pending && !after.pending) return 'order-processed';
    return 'order-modified';
  }
  if (!same(before.orderHistory, after.orderHistory)) {
    const latest = after.orderHistory?.at?.(-1);
    if (latest?.status === 'cancelled') return 'order-cancelled';
    if (latest?.status === 'filled') return 'order-filled';
    return 'order-history-changed';
  }
  if (!same(before.trades, after.trades)) {
    const trade = after.trades?.at?.(-1);
    return trade?.reason === '手动平仓' ? 'position-closed' : 'position-auto-closed';
  }
  if (!same([before.tf, before.ma, before.ma10, before.blind, before.volume], [after.tf, after.ma, after.ma10, after.blind, after.volume])) return 'view-setting';
  if (before.speed !== after.speed) return 'playback-speed';
  if (before.notes !== after.notes) return 'note-change';
  if (!same(before.draftPlan, after.draftPlan) || before.sizePercent !== after.sizePercent || before.leverage !== after.leverage || before.orderType !== after.orderType) return 'order-plan';
  return null;
}

function keyAction(kind) {
  return /^(order-|position-|protection-|drawing-)/.test(kind || '');
}

export function createReviewRecorder() {
  let dbPromise;
  let queue = Promise.resolve();
  let lastError = null;
  const highWater = new Map();
  const issueKey = 'kline-review-recording-issues-v1';
  const failureIssues = new Map();
  try {
    const savedIssues = JSON.parse(localStorage.getItem(issueKey) || '{}');
    for (const [id, values] of Object.entries(savedIssues)) if (Array.isArray(values)) failureIssues.set(id, values);
  } catch {}
  const db = () => dbPromise ||= openDatabase();
  const enqueue = (task, sessionId = null) => {
    const result = queue.then(task);
    queue = result.catch(error => {
      lastError = error;
      if (sessionId) {
        const id = String(sessionId), current = failureIssues.get(id) || [];
        failureIssues.set(id, [...current, error.message || '过程记录保存失败']);
        try { localStorage.setItem(issueKey, JSON.stringify(Object.fromEntries(failureIssues))); } catch {}
      }
    });
    return result;
  };

  async function observe(session, options = {}) {
    if (!session?.id) return;
    const sessionId = String(session.id), baseline = !(Number.isFinite(session.cursor) && Number.isFinite(session.start) && session.cursor === session.start && !(session.trades?.length) && !session.position && !session.pending);
    const snapshot = jsonClone(projection(session));
    const capturedView = jsonClone(options.view || {});
    const capturedBefore = jsonClone(options.before);
    const capturedAfter = jsonClone(options.after);
    const recordedAt = new Date().toISOString();
    // Invoke the provider before queuing IndexedDB work so the screenshot freezes
    // the exact canvas state at the action, even while replay continues.
    let screenshotPromise = null;
    if (typeof options.screenshot === 'function') {
      try { screenshotPromise = Promise.resolve(options.screenshot()).catch(error => { lastError = error; return null; }); } catch (error) { lastError = error; screenshotPromise = Promise.resolve(null); }
    } else if (options.screenshot && typeof options.screenshot.then === 'function') screenshotPromise = options.screenshot;
    return enqueue(async () => {
      const database = await db();
      const readTx = database.transaction('sessions', 'readonly');
      const readDone = transactionDone(readTx);
      const meta = await requestResult(readTx.objectStore('sessions').get(sessionId));
      await readDone;
      const beforeState = meta?.lastState ?? null;
      const afterState = snapshot;
      const inferred = inferredKind(beforeState, afterState);
      const kind = options.kind || inferred;
      const changed = !!inferred;
      if (!kind || (!changed && !options.kind)) {
        const tx = database.transaction('sessions', 'readwrite');
        const done = transactionDone(tx);
        const next = meta || {
          sessionId, recordingStartedAt: recordedAt, baseline,
          issues: [], nextSeq: 1
        };
        next.lastState = afterState;
        tx.objectStore('sessions').put(next);
        await done;
        return null;
      }
      const visibleThrough = Number.isFinite(capturedView?.visibleThrough) ? capturedView.visibleThrough : null;
      let screenshotId = null;
      let screenshotBlob = null;
      let screenshotMissing = false;
      if (keyAction(kind) && screenshotPromise) {
        try {
          screenshotBlob = await screenshotPromise;
        } catch (error) { lastError = error; }
        screenshotMissing = !(screenshotBlob instanceof Blob);
      }
      const tx = database.transaction(['sessions', 'events', 'screenshots'], 'readwrite');
      const done = transactionDone(tx);
      const sessions = tx.objectStore('sessions'), events = tx.objectStore('events'), screenshots = tx.objectStore('screenshots');
      // Allocate the sequence from the latest metadata inside the serialized
      // readwrite transaction, so two app windows cannot overwrite one event.
      const latestMeta = await requestResult(sessions.get(sessionId));
      const seq = Math.max(latestMeta?.nextSeq || 1, (highWater.get(sessionId) || 0) + 1);
      const concurrentChange = !!(latestMeta?.lastState && !same(latestMeta.lastState, beforeState));
      const event = {
        id: `${sessionId}:${seq}`, sessionId, seq, kind, recordedAt, replayMarketTime: visibleThrough, visibleThrough,
        before: capturedBefore ?? beforeState, after: capturedAfter ?? afterState,
        view: capturedView, screenshotId: null,
        ...(concurrentChange?{concurrentChange:true}:{}),
        ...(screenshotMissing?{screenshotMissing:true}:{}),
        ...(typeof options.orderId==='string'?{orderId:options.orderId}:{}),
        ...(typeof options.tradeId==='string'?{tradeId:options.tradeId}:{})
      };
      if (screenshotBlob instanceof Blob && keyAction(kind)) {
        screenshotId = `${sessionId}:${seq}:${Date.now()}`;
        event.screenshotId = screenshotId;
        screenshots.put({id: screenshotId, sessionId, eventId: `${sessionId}:${seq}`, blob: screenshotBlob, mimeType: screenshotBlob.type || 'image/png', captureType: 'live-chart-canvas-plus-composited-overlays'});
      }
      events.put(event);
      const nextMeta = latestMeta || {
        sessionId, recordingStartedAt: recordedAt, baseline,
        issues: [], nextSeq: 1
      };
      nextMeta.nextSeq = seq + 1;
      nextMeta.lastState = afterState;
      if(screenshotMissing){nextMeta.issues=[...(nextMeta.issues||[]),'关键操作截图缺失，事件仍保留。'];}
      if(concurrentChange){nextMeta.issues=[...(nextMeta.issues||[]),'检测到多个窗口同时记录，本事件before可能早于同一轮的另一窗口操作。'];}
      sessions.put(nextMeta);
      await done;
      highWater.set(sessionId, seq);
      return event;
    },sessionId);
  }

  async function appendMinute(session, row) {
    if (!session?.id || !Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(Number.isFinite)) return;
    const sessionId=String(session.id),minuteRow=row.slice(0,6),time=minuteRow[0],cutoff=Number.isFinite(session.minuteCursorTime)?session.minuteCursorTime+60:null,recordedAt=new Date().toISOString();
    return enqueue(async () => {
      const database = await db();
      const tx = database.transaction(['sessions', 'minutes'], 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore('minutes');
      const metaStore = tx.objectStore('sessions');
      let meta = await requestResult(metaStore.get(sessionId));
      if (!meta) {
        const stamp = recordedAt;
        meta = {sessionId, recordingStartedAt: stamp, baseline: true, issues: [], nextSeq: 1};
      }
      if (cutoff !== null && time + 60 <= cutoff) store.put({sessionId, time, row: minuteRow, recordedAt});
      metaStore.put(meta);
      await done;
    },sessionId);
  }

  async function captureWatermarks(sessionIds) {
    const ids = [...new Set((sessionIds || []).filter(Boolean).map(String))];
    return enqueue(async () => {
      const database = await db();
      const tx = database.transaction('sessions', 'readonly');
      const done = transactionDone(tx);
      const store = tx.objectStore('sessions'), result = {};
      const metas = await Promise.all(ids.map(id => requestResult(store.get(id))));
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], meta = metas[index];
        // The queue barrier above guarantees this tab's prior writes are flushed;
        // read the shared metadata watermark so exports also include committed
        // events from another app window that wrote before this snapshot point.
        result[id] = meta?.nextSeq ? meta.nextSeq - 1 : 0;
      }
      await done;
      return result;
    });
  }

  async function flush() {
    await queue;
    if (dbPromise) await db();
    if (lastError) throw lastError;
  }

  async function readSession(sessionId, {maxSeq = Number.MAX_SAFE_INTEGER, visibleThrough = Number.MAX_SAFE_INTEGER, snapshotAt = Number.MAX_SAFE_INTEGER} = {}) {
    const database = await db();
    const tx = database.transaction(['sessions', 'events', 'screenshots', 'minutes'], 'readonly');
    const done = transactionDone(tx);
    const key = IDBKeyRange.only(String(sessionId));
    const [meta, allEvents, allScreenshots, allMinutes] = await Promise.all([
      requestResult(tx.objectStore('sessions').get(String(sessionId))),
      requestResult(tx.objectStore('events').index('sessionId').getAll(key)),
      requestResult(tx.objectStore('screenshots').index('sessionId').getAll(key)),
      requestResult(tx.objectStore('minutes').index('sessionId').getAll(key))
    ]);
    await done;
    const events = allEvents.filter(x => x.sessionId === String(sessionId) && x.seq <= maxSeq && (x.visibleThrough === null || x.visibleThrough <= visibleThrough) && (!Number.isFinite(Date.parse(x.recordedAt)) || Date.parse(x.recordedAt) <= snapshotAt)).sort((a, b) => a.seq - b.seq);
    const includedIds = new Set(events.map(x => x.screenshotId).filter(Boolean));
    const screenshots = allScreenshots.filter(x => x.sessionId === String(sessionId) && includedIds.has(x.id)).map(({id, blob, eventId, mimeType, captureType}) => ({id, blob, eventId, mimeType, captureType}));
    const minutes = allMinutes.filter(x => x.sessionId === String(sessionId) && x.time + 60 <= visibleThrough && (!Number.isFinite(Date.parse(x.recordedAt)) || Date.parse(x.recordedAt) <= snapshotAt)).sort((a, b) => a.time - b.time).map(x => x.row);
    return {
      sessionId: String(sessionId), events, screenshots, minutes,
      recordingStartedAt: meta?.recordingStartedAt ?? null,
      baseline: meta?.baseline ?? true,
      issues: [...(meta?.issues || []), ...(failureIssues.get(String(sessionId)) || []), ...(!meta ? ['此轮在过程记录启用前已开始，未记录此前的操作和分钟行情'] : [])]
    };
  }

  return {observe, appendMinute, flush, readSession, captureWatermarks};
}

export {projection as reviewStateProjection, inferredKind as inferReviewEventKind};
