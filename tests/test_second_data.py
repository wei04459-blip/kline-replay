import csv
import gzip
import hashlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

RESOURCE_DIR = Path(__file__).resolve().parents[1] / "macos" / "Contents" / "Resources"
PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RESOURCE_DIR))

from second_data import ROWS_PER_DAY, SecondDataError, SecondDataService, parse_archive_csv
from serve import create_server


def day_start(day):
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def archive_rows(day="2025-01-01", omit_last=False, invalid_ohlc=False):
    start = day_start(day)
    multiplier = 1_000_000 if day >= "2025-01-01" else 1_000
    close_offset = multiplier - 1
    lines = []
    total = ROWS_PER_DAY - int(omit_last)
    for index in range(total):
        timestamp = (start + index) * multiplier
        high = "99" if invalid_ohlc and index == 0 else "101"
        lines.append(f"{timestamp},100,{high},99,100,0.25,{timestamp + close_offset},25,1,0,0,0")
    return ("\n".join(lines) + "\n").encode()


def archive_for(day="2025-01-01", omit_last=False):
    data = archive_rows(day, omit_last=omit_last)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr(f"BTCUSDT-1s-{day}.csv", data)
    body = stream.getvalue()
    checksum = f"{hashlib.sha256(body).hexdigest()}  BTCUSDT-1s-{day}.zip\n".encode()
    return body, checksum


class FakeResponse(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class FakeOpener:
    def __init__(self, day="2025-01-01", delay=0):
        self.body, self.checksum = archive_for(day)
        self.delay = delay
        self.calls = []
        self.guard = threading.Lock()

    def __call__(self, request, timeout):
        if timeout != 30:
            raise AssertionError("HTTP timeout must be finite")
        with self.guard:
            self.calls.append(request.full_url)
        if self.delay:
            time.sleep(self.delay)
        return FakeResponse(self.checksum if request.full_url.endswith(".CHECKSUM") else self.body)


class SecondDataTests(unittest.TestCase):
    def test_parser_normalizes_milliseconds_and_microseconds_and_keeps_volume(self):
        old = parse_archive_csv(archive_rows("2022-01-01"), "BTCUSDT", "2022-01-01")
        new = parse_archive_csv(archive_rows("2025-01-01"), "BTCUSDT", "2025-01-01")
        self.assertEqual(len(old), ROWS_PER_DAY)
        self.assertEqual(len(new), ROWS_PER_DAY)
        self.assertEqual(old[0][0], day_start("2022-01-01"))
        self.assertEqual(new[0][0], day_start("2025-01-01"))
        self.assertEqual(old[-1][0] - old[0][0], ROWS_PER_DAY - 1)
        self.assertEqual(new[0], [day_start("2025-01-01"), 100, 101, 99, 100, 0.25])

    def test_parser_rejects_missing_seconds_and_bad_ohlc(self):
        with self.assertRaisesRegex(SecondDataError, "不完整"):
            parse_archive_csv(archive_rows(omit_last=True), "BTCUSDT", "2025-01-01")
        with self.assertRaisesRegex(SecondDataError, "OHLCV"):
            parse_archive_csv(archive_rows(invalid_ohlc=True), "BTCUSDT", "2025-01-01")

    def test_allowlist_and_range_bounds(self):
        for symbol, day in (("LTCUSDT", "2025-01-01"), ("../BTCUSDT", "2025-01-01"),
                            ("BTCUSDT", "2026-01-01"), ("BTCUSDT", "2025-02-30")):
            with self.subTest(symbol=symbol, day=day), self.assertRaises(SecondDataError):
                SecondDataService.validate_request(symbol, day)

    def test_checksum_compressed_cache_and_corrupt_cache_redownload(self):
        opener = FakeOpener()
        with tempfile.TemporaryDirectory() as directory:
            service = SecondDataService(directory, opener)
            first = service.get_day("BTCUSDT", "2025-01-01")
            self.assertEqual(len(first["candles"]), ROWS_PER_DAY)
            self.assertEqual(len(opener.calls), 2)
            cache = Path(directory) / "BTCUSDT" / "2025-01-01.json.gz"
            self.assertLess(cache.stat().st_size, 8 * 1024 * 1024)
            self.assertEqual(service.get_day("BTCUSDT", "2025-01-01"), first)
            tampered = json.loads(gzip.decompress(cache.read_bytes()))
            tampered["candles"][1][1] = 999
            cache.write_bytes(gzip.compress(json.dumps(tampered).encode()))
            restored = service.get_day("BTCUSDT", "2025-01-01")
            self.assertEqual(restored["candles"][1][1], 100)
            self.assertEqual(len(opener.calls), 4)

    def test_same_day_concurrent_calls_fetch_once(self):
        opener = FakeOpener(delay=0.01)
        with tempfile.TemporaryDirectory() as directory:
            service = SecondDataService(directory, opener)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: service.get_day("BTCUSDT", "2025-01-01"), range(4)))
            self.assertTrue(all(result == results[0] for result in results))
            self.assertEqual(len(opener.calls), 2)

    def test_api_is_loopback_only_nostore_and_allowlisted(self):
        class StubService:
            @staticmethod
            def validate_request(symbol, day):
                return SecondDataService.validate_request(symbol, day)

            @staticmethod
            def get_day(symbol, day):
                return {"symbol": symbol, "date": day, "interval": 1, "candles": [[day_start(day), 1, 2, 1, 2, 3]],
                        "source": {"sha256": "a" * 64}, "cache_sha256": "hidden"}

        with tempfile.TemporaryDirectory() as cache:
            server = create_server("127.0.0.1", 0, PROJECT_DIR / "dist", cache, second_service=StubService())
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                with urllib.request.urlopen(base + "/api/v1/seconds/BTCUSDT/2025-01-01", timeout=2) as response:
                    payload = json.loads(response.read())
                    self.assertIn("no-store", response.headers["Cache-Control"])
                    self.assertEqual(payload["interval"], 1)
                    self.assertNotIn("cache_sha256", payload)
                with self.assertRaises(urllib.error.HTTPError) as bad_symbol:
                    urllib.request.urlopen(base + "/api/v1/seconds/LTCUSDT/2025-01-01", timeout=2)
                self.assertEqual(bad_symbol.exception.code, 400)
                with self.assertRaises(urllib.error.HTTPError) as bad_query:
                    urllib.request.urlopen(base + "/api/v1/seconds/BTCUSDT/2025-01-01?path=x", timeout=2)
                self.assertEqual(bad_query.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
