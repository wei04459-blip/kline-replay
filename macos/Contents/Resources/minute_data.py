"""Fetch and validate allowlisted Binance Vision 1m spot archives."""
from __future__ import annotations

import csv
import calendar
try:
    import fcntl
except ImportError:  # Windows fallback: the in-process lock still serializes the bundled server.
    fcntl = None
import hashlib
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

SYMBOLS = frozenset(("BTCUSDT", "ETHUSDT"))
MIN_DATE = date(2022, 1, 1)
MAX_DATE = date(2025, 12, 31)
BASE_URL = "https://data.binance.vision/data/spot/daily/klines"
CONNECT_TIMEOUT = 15
MAX_RETRIES = 2
MAX_CHECKSUM_BYTES = 512
MAX_ZIP_BYTES = 2 * 1024 * 1024
MAX_CSV_BYTES = 4 * 1024 * 1024
MAX_CACHE_DAYS_PER_SYMBOL = 180
USER_AGENT = "KlineReplayLocal/1.0"

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class MinuteDataError(Exception):
    """Expected, user-displayable data or network failure."""


class MinuteDataUnavailable(MinuteDataError):
    """The official archive has no daily file for this UTC date."""


def _lock_file(file_obj) -> None:
    if fcntl is not None:
        fcntl.flock(file_obj.fileno(), fcntl.LOCK_EX)


def parse_archive_csv(csv_bytes: bytes, symbol: str, day: str) -> list[list[float | int]]:
    """Parse a Binance 1m CSV into [Unix seconds, O, H, L, C, volume] rows."""
    if len(csv_bytes) > MAX_CSV_BYTES:
        raise MinuteDataError("分钟行情归档解压后超出大小限制。")
    try:
        text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MinuteDataError("分钟行情 CSV 不是有效 UTF-8。") from exc
    rows: list[list[float | int]] = []
    previous = -1
    try:
        reader = csv.reader(io.StringIO(text, newline=""))
        for line_number, fields in enumerate(reader, 1):
            if len(fields) != 12:
                raise MinuteDataError(f"{symbol} {day} 第 {line_number} 行列数异常。")
            raw_time = int(fields[0])
            if raw_time >= 10**15:
                timestamp = raw_time // 1_000_000
            elif raw_time >= 10**12:
                timestamp = raw_time // 1_000
            else:
                raise MinuteDataError(f"{symbol} {day} 第 {line_number} 行时间单位异常。")
            if timestamp % 60 or timestamp <= previous:
                raise MinuteDataError(f"{symbol} {day} 第 {line_number} 行时间未对齐、重复或逆序。")
            previous = timestamp
            values = [float(Decimal(fields[i])) for i in range(1, 6)]
            open_price, high, low, close, volume = values
            if not all(map(lambda n: n >= 0 and n != float("inf"), values)):
                raise MinuteDataError(f"{symbol} {day} 第 {line_number} 行含非法数值。")
            if min(open_price, high, low, close) <= 0 or volume < 0 or high < max(open_price, close, low) or low > min(open_price, close, high):
                raise MinuteDataError(f"{symbol} {day} 第 {line_number} 行 OHLCV 校验失败。")
            rows.append([timestamp, *values])
    except (ValueError, InvalidOperation, OverflowError) as exc:
        raise MinuteDataError(f"{symbol} {day} 的分钟行情包含无法解析的数值。") from exc
    if not rows or len(rows) > 1440:
        raise MinuteDataError(f"{symbol} {day} 的分钟行情行数异常（{len(rows)}）。")
    expected_day = date.fromisoformat(day)
    start = calendar.timegm(expected_day.timetuple())
    if rows[0][0] < start or rows[-1][0] >= start + 86400:
        raise MinuteDataError(f"{symbol} {day} 的行情时间超出指定 UTC 日。")
    return rows


def _validate_cached(payload: object, symbol: str, day: str) -> dict:
    if not isinstance(payload, dict) or payload.get("symbol") != symbol or payload.get("date") != day or payload.get("interval") != 60:
        raise MinuteDataError("本地分钟行情缓存格式无效。")
    rows = payload.get("candles")
    if not isinstance(rows, list) or not rows or len(rows) > 1440:
        raise MinuteDataError("本地分钟行情缓存为空或行数异常。")
    previous = -1
    utc_start = calendar.timegm(date.fromisoformat(day).timetuple())
    for row in rows:
        if not isinstance(row, list) or len(row) != 6:
            raise MinuteDataError("本地分钟行情缓存行格式无效。")
        timestamp, open_price, high, low, close, volume = row
        if not isinstance(timestamp, int) or timestamp % 60 or timestamp <= previous or not utc_start <= timestamp < utc_start + 86400:
            raise MinuteDataError("本地分钟行情缓存时间未对齐、重复或逆序。")
        previous = timestamp
        if not all(isinstance(value, (int, float)) and value == value and abs(value) != float("inf") for value in row[1:]):
            raise MinuteDataError("本地分钟行情缓存含非法数值。")
        if min(open_price, high, low, close) <= 0 or volume < 0 or high < max(open_price, close, low) or low > min(open_price, close, high):
            raise MinuteDataError("本地分钟行情缓存 OHLCV 校验失败。")
    source = payload.get("source")
    if not isinstance(source, dict) or not re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")):
        raise MinuteDataError("本地分钟行情缓存缺少来源校验信息。")
    canonical = json.dumps(rows, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if hashlib.sha256(canonical).hexdigest() != payload.get("cache_sha256"):
        raise MinuteDataError("本地分钟行情缓存校验失败。")
    return payload


class MinuteDataService:
    def __init__(self, cache_dir: Path | str | None = None, opener=None):
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / "Library" / "Caches" / "com.yuwan.local.kline-replay" / "minute-v1"
        self.opener = opener or urllib.request.urlopen

    @staticmethod
    def validate_request(symbol: str, day: str) -> date:
        if symbol not in SYMBOLS:
            raise MinuteDataError("只支持 BTCUSDT 和 ETHUSDT 的分钟行情。")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise MinuteDataError("日期格式应为 YYYY-MM-DD。")
        try:
            parsed = date.fromisoformat(day)
        except ValueError as exc:
            raise MinuteDataError("UTC 日期无效。") from exc
        if parsed.isoformat() != day or not MIN_DATE <= parsed <= MAX_DATE:
            raise MinuteDataError("分钟行情仅提供 2022-01-01 至 2025-12-31 UTC。")
        return parsed

    def _fetch_bytes(self, url: str, max_bytes: int) -> bytes:
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with self.opener(request, timeout=CONNECT_TIMEOUT) as response:
                    if response.status != 200:
                        raise MinuteDataError(f"Binance 分钟数据源返回 HTTP {response.status}。")
                    body = response.read(max_bytes + 1)
                    if len(body) > max_bytes:
                        raise MinuteDataError("Binance 分钟数据文件超出大小限制。")
                    return body
            except MinuteDataError:
                raise
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise MinuteDataUnavailable("该 UTC 日没有可用的 Binance 分钟归档。") from exc
                last_error = exc
            except (TimeoutError, OSError, urllib.error.URLError) as exc:
                last_error = exc
            if attempt + 1 < MAX_RETRIES:
                time.sleep(0.25 * (attempt + 1))
        raise MinuteDataError("无法连接 Binance 分钟数据源，请检查网络后重试。") from last_error

    def _thread_lock(self, key: str) -> threading.Lock:
        with _THREAD_LOCKS_GUARD:
            return _THREAD_LOCKS.setdefault(key, threading.Lock())

    def get_day(self, symbol: str, day: str) -> dict:
        self.validate_request(symbol, day)
        symbol_dir = self.cache_dir / symbol
        if symbol_dir.is_symlink():
            raise MinuteDataError("本地分钟行情缓存目录无效。")
        target = symbol_dir / f"{day}.json"
        lock_path = target.parent / f"{day[:7]}.lock"
        target.parent.mkdir(parents=True, exist_ok=True)
        key = str(target)
        with self._thread_lock(key):
            if lock_path.is_symlink():
                lock_path.unlink(missing_ok=True)
            with lock_path.open("a+b") as lock_file:
                _lock_file(lock_file)
                if target.is_symlink():
                    target.unlink(missing_ok=True)
                if target.exists():
                    try:
                        if target.stat().st_size > 1024 * 1024:
                            raise MinuteDataError("本地分钟行情缓存超出大小限制。")
                        payload = _validate_cached(json.loads(target.read_text(encoding="utf-8")), symbol, day)
                        os.utime(target, None)
                        return payload
                    except (OSError, json.JSONDecodeError, MinuteDataError):
                        target.unlink(missing_ok=True)

                stem = f"{symbol}-1m-{day}.zip"
                base = f"{BASE_URL}/{symbol}/1m/{stem}"
                try:
                    checksum_text = self._fetch_bytes(base + ".CHECKSUM", MAX_CHECKSUM_BYTES).decode("ascii", errors="strict").strip()
                except UnicodeDecodeError as exc:
                    raise MinuteDataError("Binance 分钟归档校验文件编码无效。") from exc
                checksum_parts = checksum_text.split()
                if len(checksum_parts) < 2 or checksum_parts[0].lower() != checksum_parts[0] or not re.fullmatch(r"[0-9a-f]{64}", checksum_parts[0]) or checksum_parts[-1] != stem:
                    raise MinuteDataError("Binance 分钟归档校验文件格式无效。")
                archive = self._fetch_bytes(base, MAX_ZIP_BYTES)
                sha256 = hashlib.sha256(archive).hexdigest()
                if sha256 != checksum_parts[0]:
                    raise MinuteDataError("Binance 分钟归档 SHA256 校验失败，未使用该文件。")
                try:
                    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
                        members = [name for name in zipped.namelist() if not name.endswith("/")]
                        if len(members) != 1 or members[0] != stem[:-4] + ".csv":
                            raise MinuteDataError("Binance 分钟 ZIP 内文件名或数量异常。")
                        info = zipped.getinfo(members[0])
                        if info.file_size > MAX_CSV_BYTES:
                            raise MinuteDataError("Binance 分钟 CSV 解压后超出大小限制。")
                        candles = parse_archive_csv(zipped.read(members[0]), symbol, day)
                except zipfile.BadZipFile as exc:
                    raise MinuteDataError("Binance 分钟归档 ZIP 已损坏。") from exc
                payload = {"symbol": symbol, "date": day, "interval": 60, "candles": candles,
                           "source": {"url": base, "checksum_url": base + ".CHECKSUM", "sha256": sha256}}
                canonical = json.dumps(candles, separators=(",", ":"), ensure_ascii=True).encode("ascii")
                payload["cache_sha256"] = hashlib.sha256(canonical).hexdigest()
                encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
                temporary = target.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
                try:
                    with temporary.open("wb") as output:
                        output.write(encoded)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                self._prune(symbol, exclude=target)
                return payload

    def _prune(self, symbol: str, exclude: Path) -> None:
        files = sorted((self.cache_dir / symbol).glob("????-??-??.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for stale in files[MAX_CACHE_DAYS_PER_SYMBOL:]:
            if stale != exclude:
                stale.unlink(missing_ok=True)
