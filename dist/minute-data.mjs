const API_ROOT = './api/v1/minutes';
const ALLOWED = new Set(['BTCUSDT', 'ETHUSDT']);
const EARLIEST = Date.UTC(2022, 0, 1) / 1000;
const LATEST_EXCLUSIVE = Date.UTC(2026, 0, 1) / 1000;
const MAX_CACHED_DAYS = 3;
const MAX_EMPTY_DAYS = 7;
const FETCH_TIMEOUT_MS = 90_000;
const dayCache = new Map();
const pendingDays = new Map();
const archiveMetaCache = new Map();

function utcDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function nextDay(day) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function rememberArchiveMeta(key, payload) {
  archiveMetaCache.delete(key);
  archiveMetaCache.set(key, {source: payload?.source ?? null});
  while (archiveMetaCache.size > 180) archiveMetaCache.delete(archiveMetaCache.keys().next().value);
}

function validCandle(row, date) {
  if (!Array.isArray(row) || row.length !== 6) return false;
  const [time, open, high, low, close, volume] = row;
  if (!Number.isInteger(time) || time % 60 !== 0 || utcDay(time) !== date) return false;
  if (![open, high, low, close, volume].every(Number.isFinite)) return false;
  return Math.min(open, high, low, close) > 0 && volume >= 0 && high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
}

function validatePayload(payload, symbol, date) {
  if (!payload || payload.symbol !== symbol || payload.date !== date || payload.interval !== 60 ||
      !Array.isArray(payload.candles) || payload.candles.length < 1 || payload.candles.length > 1440 ||
      !payload.source || !/^[0-9a-f]{64}$/.test(payload.source.sha256 || '')) {
    throw new Error(`本地服务返回的 ${symbol} ${date} 分钟数据格式无效。`);
  }
  let previous = -1;
  for (const row of payload.candles) {
    if (!validCandle(row, date) || row[0] <= previous) throw new Error(`本地服务返回的 ${symbol} ${date} 分钟数据时间或 OHLCV 无效。`);
    previous = row[0];
  }
  return payload.candles;
}

async function loadDay(symbol, date) {
  const key = `${symbol}/${date}`;
  if (dayCache.has(key)) {
    const value = dayCache.get(key);
    dayCache.delete(key);
    dayCache.set(key, value);
    return value;
  }
  if (pendingDays.has(key)) return pendingDays.get(key);
  const promise = (async () => {
    let response, payload;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      response = await fetch(`${API_ROOT}/${symbol}/${date}`, {cache: 'no-store', signal: controller.signal});
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('读取分钟行情超时，请检查网络后重试。');
      if (response) throw new Error('本地分钟行情服务返回了无法读取的数据。');
      throw new Error('无法连接本地分钟行情服务，请确认使用 K线回放.app 启动。');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `读取分钟行情失败（HTTP ${response.status}）。`);
      error.httpStatus = response.status;
      throw error;
    }
    const candles = validatePayload(payload, symbol, date);
    rememberArchiveMeta(key, payload);
    dayCache.set(key, candles);
    while (dayCache.size > MAX_CACHED_DAYS) dayCache.delete(dayCache.keys().next().value);
    return candles;
  })();
  pendingDays.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingDays.delete(key);
  }
}

/** Read only real, checksum-validated daily archives in an explicit UTC interval.
 * `throughExclusive` is a candle close-time cutoff: a row is included only if
 * openTime + 60 <= throughExclusive. `dayCache` can deduplicate daily payloads
 * across sessions in one export without widening any session's returned rows.
 */
export async function readMinuteRange(symbol, fromInclusive, throughExclusive, {
  dayCache = new Map(), onProgress = () => {}, signal,
} = {}) {
  if (!ALLOWED.has(symbol)) throw new Error('分钟行情只支持 BTCUSDT 和 ETHUSDT。');
  if (!Number.isFinite(fromInclusive) || !Number.isFinite(throughExclusive) || fromInclusive < EARLIEST ||
      throughExclusive <= fromInclusive || throughExclusive > LATEST_EXCLUSIVE) {
    throw new Error('分钟行情读取范围超出 2022–2025 UTC 数据范围。');
  }
  const firstOpen = Math.ceil(fromInclusive / 60) * 60;
  const lastOpen = Math.floor((throughExclusive - 60) / 60) * 60;
  if (lastOpen < firstOpen) return {candles: [], days: [], unavailable: [], stoppedAt: null};
  const days = [];
  let day = utcDay(firstOpen);
  const finalDay = utcDay(lastOpen);
  const candles = [];
  const unavailable = [];
  let stoppedAt = null;
  while (day <= finalDay) {
    if (signal?.aborted) throw new DOMException('导出已取消。', 'AbortError');
    const key = `${symbol}/${day}`;
    let payload;
    try {
      if (dayCache.has(key)) payload = await dayCache.get(key);
      else {
        const pending = loadDay(symbol, day);
        const wrapper = pending.then(candles => ({candles, source: archiveMetaCache.get(key)?.source ?? null}));
        dayCache.set(key, wrapper);
        try { payload = await wrapper; dayCache.set(key, payload); }
        catch (error) { dayCache.delete(key); throw error; }
      }
      const rows = Array.isArray(payload) ? payload : payload?.candles;
      if (!Array.isArray(rows) || rows.some(row => !validCandle(row, day))) {
        throw new Error(`本地服务返回的 ${symbol} ${day} 分钟数据格式无效。`);
      }
      const selected = rows.filter(row => row[0] >= firstOpen && row[0] <= lastOpen && row[0] + 60 <= throughExclusive);
      candles.push(...selected);
      const metadata = Array.isArray(payload) ? archiveMetaCache.get(key)?.source : payload.source;
      days.push({symbol, date: day, ...(metadata ? {url: metadata.url, checksumUrl: metadata.checksum_url,
        archiveSha256: metadata.sha256} : {}), rowCount: selected.length,
        fullUtcDayVisible: throughExclusive >= Date.parse(`${nextDay(day)}T00:00:00Z`) / 1000,
        firstOpen: selected[0]?.[0] ?? null, lastOpen: selected.at(-1)?.[0] ?? null});
    } catch (error) {
      const unavailableEntry = {symbol, date: day, reason: error?.message || '无法读取此日分钟数据。', httpStatus: error?.httpStatus ?? null};
      unavailable.push(unavailableEntry);
      if (error?.httpStatus === 404) {
        days.push({symbol, date: day, unavailable: true, reason: unavailableEntry.reason, rowCount: 0});
      } else {
        stoppedAt = day;
        break;
      }
    }
    onProgress({symbol, date: day, rows: candles.length, unavailable: unavailable.length});
    day = nextDay(day);
  }
  return {candles, days, unavailable, stoppedAt};
}

/** Return the next verified real 1m candle whose open time is after afterTime. */
export async function nextMinute(symbol, afterTime) {
  if (!ALLOWED.has(symbol)) throw new Error('分钟行情只支持 BTCUSDT 和 ETHUSDT。');
  if (!Number.isFinite(afterTime) || afterTime < EARLIEST - 60 || afterTime >= LATEST_EXCLUSIVE) {
    throw new Error('分钟行情游标超出 2022–2025 UTC 数据范围。');
  }
  const firstWanted = Math.floor(afterTime / 60) * 60 + 60;
  if (firstWanted >= LATEST_EXCLUSIVE) throw new Error('该时间之后没有 2025 年范围内的真实分钟K线。');
  let date = utcDay(firstWanted);
  for (let emptyDays = 0; emptyDays < MAX_EMPTY_DAYS; emptyDays += 1) {
    let rows;
    try {
      rows = await loadDay(symbol, date);
    } catch (error) {
      throw error;
    }
    const next = rows.find(row => row[0] > afterTime);
    if (next) return next;
    date = nextDay(date);
    if (Date.parse(`${date}T00:00:00Z`) / 1000 >= LATEST_EXCLUSIVE) break;
  }
  throw new Error('该时间之后没有找到真实分钟K线，请检查归档缺口或练习范围。');
}
