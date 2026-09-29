const API_ROOT = './api/v1/seconds';
const ALLOWED = new Set(['BTCUSDT', 'ETHUSDT']);
const EARLIEST = Date.UTC(2022, 0, 1) / 1000;
const LATEST_EXCLUSIVE = Date.UTC(2026, 0, 1) / 1000;
const SECONDS_PER_DAY = 86_400;
const MAX_CACHED_DAYS = 2;
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

function nextMidnight(day) {
  return Date.parse(`${nextDay(day)}T00:00:00Z`) / 1000;
}

function validRow(row, expectedTime) {
  if (!Array.isArray(row) || row.length !== 6) return false;
  const [time, open, high, low, close, volume] = row;
  if (time !== expectedTime || !Number.isInteger(time)) return false;
  if (![open, high, low, close, volume].every(Number.isFinite)) return false;
  return Math.min(open, high, low, close) > 0 && volume >= 0 &&
    high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
}

function validatePayload(payload, symbol, day) {
  if (!payload || payload.symbol !== symbol || payload.date !== day || payload.interval !== 1 ||
      !Array.isArray(payload.candles) || payload.candles.length !== SECONDS_PER_DAY ||
      !payload.source || !/^[0-9a-f]{64}$/.test(payload.source.sha256 || '')) {
    throw new Error(`本地服务返回的 ${symbol} ${day} 秒数据格式不完整。`);
  }
  const first = Date.parse(`${day}T00:00:00Z`) / 1000;
  for (let index = 0; index < payload.candles.length; index += 1) {
    if (!validRow(payload.candles[index], first + index)) {
      throw new Error(`本地服务返回的 ${symbol} ${day} 第 ${index + 1} 秒缺失、乱序或 OHLCV 无效。`);
    }
  }
  return payload.candles;
}

async function loadDay(symbol, day) {
  const key = `${symbol}/${day}`;
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
      response = await fetch(`${API_ROOT}/${symbol}/${day}`, {cache: 'no-store', signal: controller.signal});
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('读取逐秒行情超时，请检查网络后重试。');
      if (response) throw new Error('本地逐秒行情服务返回了无法读取的数据。');
      throw new Error('无法连接本地逐秒行情服务，请确认使用 K线回放.app 启动。');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `读取逐秒行情失败（HTTP ${response.status}）。`);
      error.httpStatus = response.status;
      throw error;
    }
    const candles = validatePayload(payload, symbol, day);
    archiveMetaCache.delete(key);
    archiveMetaCache.set(key, payload.source);
    while (archiveMetaCache.size > 32) archiveMetaCache.delete(archiveMetaCache.keys().next().value);
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

/** Return only complete, real 1s kline rows inside a frozen UTC cutoff.
 * throughExclusive is a close-time boundary: t+1 must be <= cutoff.
 * Missing day archives stop the range; no minute-bar fallback is attempted.
 */
export async function readSecondRange(symbol, fromInclusive, throughExclusive, {
  onProgress = () => {}, signal,
} = {}) {
  if (!ALLOWED.has(symbol)) throw new Error('逐秒行情只支持 BTCUSDT 和 ETHUSDT。');
  if (!Number.isInteger(fromInclusive) || !Number.isInteger(throughExclusive) ||
      fromInclusive < EARLIEST || throughExclusive <= fromInclusive || throughExclusive > LATEST_EXCLUSIVE) {
    throw new Error('逐秒行情读取范围超出 2022–2025 UTC 数据范围。');
  }
  const firstOpen = fromInclusive;
  const lastOpen = throughExclusive - 1;
  if (lastOpen < firstOpen) return {candles: [], days: [], unavailable: [], stoppedAt: null};
  const candles = [];
  const days = [];
  const unavailable = [];
  let stoppedAt = null;
  for (let day = utcDay(firstOpen), finalDay = utcDay(lastOpen); day <= finalDay; day = nextDay(day)) {
    if (signal?.aborted) throw new DOMException('秒级读取已取消。', 'AbortError');
    let rows;
    try {
      rows = await loadDay(symbol, day);
    } catch (error) {
      unavailable.push({symbol, date: day, reason: error?.message || '无法读取此日1秒数据。', httpStatus: error?.httpStatus ?? null});
      stoppedAt = day;
      break;
    }
    const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
    const start = Math.max(firstOpen, dayStart);
    const end = Math.min(throughExclusive, nextMidnight(day));
    const selected = rows.slice(start - dayStart, end - dayStart);
    for (const candle of selected) candles.push(candle);
    const source = archiveMetaCache.get(`${symbol}/${day}`) || null;
    days.push({symbol, date: day, ...(source ? {url: source.url, checksumUrl: source.checksum_url, archiveSha256: source.sha256} : {}),
      rowCount: selected.length, firstOpen: selected[0]?.[0] ?? null, lastOpen: selected.at(-1)?.[0] ?? null,
      fullUtcDayVisible: start === dayStart && end === nextMidnight(day)});
    onProgress({symbol, date: day, rows: candles.length});
  }
  return {candles, days, unavailable, stoppedAt};
}

/** Return the next real 1s kline, strictly after afterTime. */
export async function nextSecond(symbol, afterTime) {
  if (!ALLOWED.has(symbol)) throw new Error('逐秒行情只支持 BTCUSDT 和 ETHUSDT。');
  if (!Number.isInteger(afterTime) || afterTime < EARLIEST - 1 || afterTime >= LATEST_EXCLUSIVE) {
    throw new Error('逐秒行情游标超出 2022–2025 UTC 数据范围。');
  }
  const wanted = afterTime + 1;
  if (wanted >= LATEST_EXCLUSIVE) return null;
  const day = utcDay(wanted);
  const rows = await loadDay(symbol, day);
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  return rows[wanted - dayStart] || null;
}

/** Return the checksum-verified Binance archive descriptor for an already loaded UTC day. */
export function secondSourceFor(symbol, epochSecond) {
  if (!ALLOWED.has(symbol) || !Number.isInteger(epochSecond) || epochSecond < EARLIEST || epochSecond >= LATEST_EXCLUSIVE) return null;
  const source = archiveMetaCache.get(`${symbol}/${utcDay(epochSecond)}`);
  return source ? {...source, date: utcDay(epochSecond)} : null;
}

export const secondDataIntervals = Object.freeze([1]);
