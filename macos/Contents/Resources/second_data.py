"""Fetch and validate Binance Vision 1s spot kline daily archives."""
from __future__ import annotations

import calendar
import csv
import gzip
import hashlib
import io
import json
import math
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

try:
    import fcntl
except ImportError:  # pragma: no cover - in-process lock is still used on Windows
    fcntl = None

SYMBOLS = frozenset(("BTCUSDT", "ETHUSDT"))
MIN_DATE = date(2022, 1, 1)
MAX_DATE = date(2025, 12, 31)
BASE_URL = "https://data.binance.vision/data/spot/daily/klines"
CONNECT_TIMEOUT = 30
MAX_RETRIES = 2
MAX_CHECKSUM_BYTES = 512
MAX_ZIP_BYTES = 32 * 1024 * 1024
MAX_CSV_BYTES = 64 * 1024 * 1024
MAX_CACHE_BYTES = 32 * 1024 * 1024
MAX_CACHE_DAYS_PER_SYMBOL = 14
ROWS_PER_DAY = 86_400
USER_AGENT = "KlineReplayLocal/1.0"

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class SecondDataError(Exception):
    """Expected, user-displayable seconds data or network failure."""


class SecondDataUnavailable(SecondDataError):
    """The official archive has no daily file for this UTC date."""


def _lock_file(file_obj) -> None:
    if fcntl is not None:
        fcntl.flock(file_obj.fileno(), fcntl.LOCK_EX)


def _timestamp_to_seconds(value: str, symbol: str, day: str, line_number: int) -> tuple[int, int]:
    raw = int(value)
    if raw >= 10**15:
        divisor = 1_000_000
        unit = 1_000_000
    elif raw >= 10**12:
        divisor = 1_000
        unit = 1_000
    else:
        raise SecondDataError(f"{symbol} {day} 第 {line_number} 行时间单位异常。")
    if raw % divisor:
        raise SecondDataError(f"{symbol} {day} 第 {line_number} 行不是整秒开盘时间。")
    return raw // divisor, unit


def parse_archive_csv(csv_bytes: bytes, symbol: str, day: str) -> list[list[float | int]]:
    """Parse a Binance 1s CSV into contiguous [UTC epoch seconds, O, H, L, C, V]."""
    if len(csv_bytes) > MAX_CSV_BYTES:
        raise SecondDataError("1秒行情归档解压后超出大小限制。")
    try:
        text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SecondDataError("1秒行情 CSV 不是有效 UTF-8。") from exc
    try:
        parsed_day = date.fromisoformat(day)
    except ValueError as exc:
        raise SecondDataError("UTC 日期无效。") from exc
    day_start = calendar.timegm(parsed_day.timetuple())
    candles: list[list[float | int]] = []
    previous = day_start - 1
    try:
        reader = csv.reader(io.StringIO(text, newline=""))
        for line_number, fields in enumerate(reader, 1):
            if line_number > ROWS_PER_DAY:
                raise SecondDataError(f"{symbol} {day} 的秒行情超过每日 {ROWS_PER_DAY} 行。")
            if len(fields) != 12:
                raise SecondDataError(f"{symbol} {day} 第 {line_number} 行列数异常。")
            timestamp, unit = _timestamp_to_seconds(fields[0], symbol, day, line_number)
            if timestamp != previous + 1 or not day_start <= timestamp < day_start + 86_400:
                raise SecondDataError(f"{symbol} {day} 第 {line_number} 行缺秒、重复、逆序或超出 UTC 日期。")
            raw_close_time = int(fields[6])
            if raw_close_time != int(fields[0]) + unit - 1:
                raise SecondDataError(f"{symbol} {day} 第 {line_number} 行开收盘时间单位不一致。")
            values = [float(Decimal(fields[index])) for index in range(1, 6)]
            open_price, high, low, close, volume = values
            if not all(math.isfinite(value) for value in values):
                raise SecondDataError(f"{symbol} {day} 第 {line_number} 行含非法数值。")
            if (min(open_price, high, low, close) <= 0 or volume < 0 or
                    high < max(open_price, close, low) or low > min(open_price, close, high)):
                raise SecondDataError(f"{symbol} {day} 第 {line_number} 行 OHLCV 校验失败。")
            candles.append([timestamp, *values])
            previous = timestamp
    except (ValueError, InvalidOperation, OverflowError) as exc:
        if isinstance(exc, SecondDataError):
            raise
        raise SecondDataError(f"{symbol} {day} 的1秒行情包含无法解析的数值。") from exc
    if len(candles) != ROWS_PER_DAY:
        raise SecondDataError(f"{symbol} {day} 秒行情不完整（{len(candles)}/{ROWS_PER_DAY}），未提供不完整日。")
    if candles[0][0] != day_start or candles[-1][0] != day_start + ROWS_PER_DAY - 1:
        raise SecondDataError(f"{symbol} {day} 秒行情未覆盖完整 UTC 日期。")
    return candles


def _validate_cached(payload: object, symbol: str, day: str) -> dict:
    if not isinstance(payload, dict) or payload.get("symbol") != symbol or payload.get("date") != day or payload.get("interval") != 1:
        raise SecondDataError("本地秒行情缓存格式无效。")
    candles = payload.get("candles")
    if not isinstance(candles, list) or len(candles) != ROWS_PER_DAY:
        raise SecondDataError("本地秒行情缓存不完整。")
    day_start = calendar.timegm(date.fromisoformat(day).timetuple())
    for index, row in enumerate(candles):
        expected_time = day_start + index
        if not isinstance(row, list) or len(row) != 6 or row[0] != expected_time:
            raise SecondDataError("本地秒行情缓存时间缺秒、重复或逆序。")
        values = row[1:]
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
            raise SecondDataError("本地秒行情缓存含非法数值。")
        open_price, high, low, close, volume = values
        if min(open_price, high, low, close) <= 0 or volume < 0 or high < max(open_price, close, low) or low > min(open_price, close, high):
            raise SecondDataError("本地秒行情缓存 OHLCV 校验失败。")
    source = payload.get("source")
    if not isinstance(source, dict) or not re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")):
        raise SecondDataError("本地秒行情缓存缺少来源校验信息。")
    canonical = json.dumps(candles, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if hashlib.sha256(canonical).hexdigest() != payload.get("cache_sha256"):
        raise SecondDataError("本地秒行情缓存校验失败。")
    return payload


class SecondDataService:
    """Bounded local cache for official full-day Binance Vision 1s klines."""

    def __init__(self, cache_dir: Path | str | None = None, opener=None):
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / "Library" / "Caches" / "com.yuwan.local.kline-replay" / "seconds-v1"
        self.opener = opener or __import__("urllib.request", fromlist=["urlopen"]).urlopen

    @staticmethod
    def validate_request(symbol: str, day: str) -> date:
        if symbol not in SYMBOLS:
            raise SecondDataError("只支持 BTCUSDT 和 ETHUSDT 的1秒行情。")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise SecondDataError("日期格式应为 YYYY-MM-DD。")
        try:
            parsed = date.fromisoformat(day)
        except ValueError as exc:
            raise SecondDataError("UTC 日期无效。") from exc
        if parsed.isoformat() != day or not MIN_DATE <= parsed <= MAX_DATE:
            raise SecondDataError("1秒行情仅提供 2022-01-01 至 2025-12-31 UTC。")
        return parsed

    def _fetch_bytes(self, url: str, max_bytes: int) -> bytes:
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with self.opener(request, timeout=CONNECT_TIMEOUT) as response:
                    if response.status != 200:
                        raise SecondDataError(f"Binance 1秒归档返回 HTTP {response.status}。")
                    body = response.read(max_bytes + 1)
                    if len(body) > max_bytes:
                        raise SecondDataError("Binance 1秒归档超出大小限制。")
                    return body
            except SecondDataError:
                raise
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise SecondDataUnavailable("该 UTC 日没有可用的 Binance 1秒归档。") from exc
                last_error = exc
            except (TimeoutError, OSError, urllib.error.URLError) as exc:
                last_error = exc
            if attempt + 1 < MAX_RETRIES:
                time.sleep(0.25 * (attempt + 1))
        raise SecondDataError("无法连接 Binance 1秒数据源，请检查网络后重试。") from last_error

    def _thread_lock(self, key: str) -> threading.Lock:
        with _THREAD_LOCKS_GUARD:
            return _THREAD_LOCKS.setdefault(key, threading.Lock())

    def get_day(self, symbol: str, day: str) -> dict:
        self.validate_request(symbol, day)
        symbol_dir = self.cache_dir / symbol
        if symbol_dir.is_symlink():
            raise SecondDataError("本地秒行情缓存目录无效。")
        target = symbol_dir / f"{day}.json.gz"
        lock_path = symbol_dir / f"{day[:7]}.lock"
        symbol_dir.mkdir(parents=True, exist_ok=True)
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
                        if target.stat().st_size > MAX_CACHE_BYTES:
                            raise SecondDataError("本地秒行情缓存超出大小限制。")
                        with gzip.open(target, "rb") as cached:
                            payload = _validate_cached(json.loads(cached.read().decode("utf-8")), symbol, day)
                        os.utime(target, None)
                        return payload
                    except (OSError, EOFError, json.JSONDecodeError, SecondDataError):
                        target.unlink(missing_ok=True)

                stem = f"{symbol}-1s-{day}.zip"
                base = f"{BASE_URL}/{symbol}/1s/{stem}"
                try:
                    checksum_text = self._fetch_bytes(base + ".CHECKSUM", MAX_CHECKSUM_BYTES).decode("ascii", errors="strict").strip()
                except UnicodeDecodeError as exc:
                    raise SecondDataError("Binance 1秒归档校验文件编码无效。") from exc
                checksum_parts = checksum_text.split()
                if (len(checksum_parts) < 2 or not re.fullmatch(r"[0-9a-f]{64}", checksum_parts[0]) or
                        checksum_parts[-1] != stem):
                    raise SecondDataError("Binance 1秒归档校验文件格式无效。")
                archive = self._fetch_bytes(base, MAX_ZIP_BYTES)
                archive_sha = hashlib.sha256(archive).hexdigest()
                if archive_sha != checksum_parts[0]:
                    raise SecondDataError("Binance 1秒归档 SHA256 校验失败，未使用该文件。")
                try:
                    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
                        members = [name for name in zipped.namelist() if not name.endswith("/")]
                        if len(members) != 1 or members[0] != stem[:-4] + ".csv":
                            raise SecondDataError("Binance 1秒 ZIP 内文件名或数量异常。")
                        info = zipped.getinfo(members[0])
                        if info.file_size > MAX_CSV_BYTES:
                            raise SecondDataError("Binance 1秒 CSV 解压后超出大小限制。")
                        candles = parse_archive_csv(zipped.read(members[0]), symbol, day)
                except zipfile.BadZipFile as exc:
                    raise SecondDataError("Binance 1秒归档 ZIP 已损坏。") from exc
                payload = {"symbol": symbol, "date": day, "interval": 1, "candles": candles,
                           "source": {"url": base, "checksum_url": base + ".CHECKSUM", "sha256": archive_sha}}
                canonical = json.dumps(candles, separators=(",", ":"), ensure_ascii=True).encode("ascii")
                payload["cache_sha256"] = hashlib.sha256(canonical).hexdigest()
                encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
                compressed = gzip.compress(encoded, compresslevel=6, mtime=0)
                if len(compressed) > MAX_CACHE_BYTES:
                    raise SecondDataError("本地秒行情缓存超出大小限制。")
                temporary = target.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
                try:
                    with temporary.open("wb") as output:
                        output.write(compressed)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                self._prune(symbol, exclude=target)
                return payload

    def _prune(self, symbol: str, exclude: Path) -> None:
        files = sorted((self.cache_dir / symbol).glob("????-??-??.json.gz"), key=lambda path: path.stat().st_mtime, reverse=True)
        for stale in files[MAX_CACHE_DAYS_PER_SYMBOL:]:
            if stale != exclude:
                stale.unlink(missing_ok=True)
