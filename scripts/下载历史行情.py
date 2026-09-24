"""下载并校验 Binance Vision BTC/ETH 现货 15m 月线数据（2022-01 至 2025-12）。"""
import csv
import hashlib
import io
import json
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE_URL = "https://data.binance.vision/data/spot/monthly/klines"
SYMBOLS = ("BTCUSDT", "ETHUSDT")
YEARS = range(2022, 2026)
MAX_WORKERS = 4
RETRIES = 3
TIMEOUT_SECONDS = 45
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "dist" / "data"
CACHE_DIR = ROOT / ".cache" / "binance-spot-15m"


def fetch(url):
    last_error = None
    for attempt in range(RETRIES):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "KlinePracticeData/1.0"})
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return response.read()
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt + 1 < RETRIES:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: 重试 {RETRIES} 次仍失败: {last_error}")


def download(job):
    symbol, year, month = job
    filename = f"{symbol}-15m-{year}-{month:02d}.zip"
    url = f"{BASE_URL}/{symbol}/15m/{filename}"
    checksum_url = url + ".CHECKSUM"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_zip = CACHE_DIR / filename
    cached_checksum = CACHE_DIR / (filename + ".CHECKSUM")

    # Always obtain the publisher's current checksum; a cached archive is reused
    # only after its bytes match that checksum.
    checksum_text = fetch(checksum_url).decode("ascii", errors="strict").strip()
    expected = checksum_text.split()[0].lower()
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise ValueError(f"{checksum_url}: SHA256 格式无效")
    cached_checksum.write_text(checksum_text + "\n", encoding="ascii")
    raw = cached_zip.read_bytes() if cached_zip.exists() else b""
    if not raw or hashlib.sha256(raw).hexdigest() != expected:
        raw = fetch(url)
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise ValueError(f"{url}: SHA256 不匹配，期望 {expected}，实际 {actual}")
        cached_zip.write_bytes(raw)

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if len(names) != 1:
            raise ValueError(f"{url}: ZIP 内 CSV 数量不是 1")
        with archive.open(names[0]) as stream:
            rows = list(csv.reader(io.TextIOWrapper(stream, encoding="utf-8")))

    candles = []
    timestamp_units = set()
    for row in rows:
        if len(row) < 6:
            raise ValueError(f"{url}: CSV 列数不足")
        raw_ts = int(row[0])
        if raw_ts >= 100_000_000_000_000:  # Binance spot archives use microseconds from 2025 onward.
            timestamp_units.add("microseconds")
            timestamp = raw_ts // 1_000_000
        elif raw_ts >= 100_000_000_000:
            timestamp_units.add("milliseconds")
            timestamp = raw_ts // 1_000
        else:
            raise ValueError(f"{url}: 无法识别时间戳单位: {raw_ts}")
        o, h, low, close = map(float, row[1:5])
        volume = float(row[5])
        if not all(map(lambda x: x == x and abs(x) != float("inf"), (o, h, low, close, volume))):
            raise ValueError(f"{url}: OHLCV 含非有限数值")
        if not (low > 0 and low <= min(o, close) <= max(o, close) <= h and volume >= 0):
            raise ValueError(f"{url}: OHLCV 无效: {row[:6]}")
        candles.append([timestamp, o, h, low, close, volume])

    source = {
        "url": url,
        "checksum_url": checksum_url,
        "sha256": expected,
        "timestamp_unit": ",".join(sorted(timestamp_units)),
        "rows": len(candles),
    }
    print(f"{symbol} {year}-{month:02d}: {len(candles)} 根，通过 SHA256", flush=True)
    return symbol, year, month, candles, source


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [(s, y, m) for s in SYMBOLS for y in YEARS for m in range(1, 13)]
    by_symbol = {s: {} for s in SYMBOLS}
    errors = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(download, job): job for job in jobs}
        for future in as_completed(futures):
            job = futures[future]
            try:
                symbol, year, month, rows, source = future.result()
                by_symbol[symbol][(year, month)] = (rows, source)
            except Exception as exc:
                errors.append((job, str(exc)))
                print(f"失败 {job}: {exc}", flush=True)

    for symbol in SYMBOLS:
        parts = by_symbol[symbol]
        if len(parts) != len(YEARS) * 12:
            print(f"{symbol}: {len(parts)}/48 个月已验证；保留已有 JSON，不写入不完整行情。", flush=True)
            continue
        candles = []
        sources = []
        for key in sorted(parts):
            rows, source = parts[key]
            candles.extend(rows)
            sources.append(source)
        candles.sort(key=lambda row: row[0])
        deduped = []
        seen = set()
        for row in candles:
            if row[0] not in seen:
                seen.add(row[0])
                deduped.append(row)
        if len(deduped) != len(candles):
            raise ValueError(f"{symbol}: 存在重复时间戳，拒绝写入")
        gaps = []
        for previous, following in zip(deduped, deduped[1:]):
            delta = following[0] - previous[0]
            if delta <= 0 or delta % 900:
                raise ValueError(f"{symbol}: 时间顺序或900秒步长异常: {previous[0]} → {following[0]}")
            if delta > 900:
                gaps.append({
                    "previous": previous[0],
                    "next": following[0],
                    "missingBars": delta // 900 - 1,
                    "from": previous[0] + 900,
                    "to": following[0] - 900,
                })
        if any(not (r[3] <= min(r[1], r[4]) <= max(r[1], r[4]) <= r[2]) for r in deduped):
            raise ValueError(f"{symbol}: 汇总后 OHLC 校验失败")
        payload = {
            "symbol": symbol,
            "interval": 900,
            "source": "Binance Vision 现货公开历史档案",
            "period": "2022-01-01 至 2025-12-31（UTC）",
            "range": {"start": deduped[0][0], "end": deduped[-1][0]},
            "count": len(deduped),
            "continuous": not gaps,
            "gaps": gaps,
            "sources": sources,
            "candles": deduped,
        }
        target = DATA_DIR / f"{symbol}.json"
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
        print(f"{symbol}: 写入 {len(deduped)} 根，{deduped[0][0]} 至 {deduped[-1][0]}", flush=True)

    if errors:
        print(f"完成但有 {len(errors)} 个来源失败；完整资产已更新，不完整资产保留旧文件。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
