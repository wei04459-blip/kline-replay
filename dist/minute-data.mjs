const API_ROOT = './api/v1/minutes';
const ALLOWED = new Set(['BTCUSDT', 'ETHUSDT']);
const EARLIEST = Date.UTC(2022, 0, 1) / 1000;
const LATEST_EXCLUSIVE = Date.UTC(2026, 0, 1) / 1000;
const MAX_CACHED_DAYS = 3;
const MAX_EMPTY_DAYS = 7;
const FETCH_TIMEOUT_MS = 90_000;
const dayCache = new Map();
const pendingDays = new Map();

function utcDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function nextDay(day) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
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
