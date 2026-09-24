import csv
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

from minute_data import MinuteDataError, MinuteDataService, parse_archive_csv
from serve import create_server


def open_time(day="2025-01-01", hour=0, minute=0, micros=False):
    seconds = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()) + hour * 3600 + minute * 60
    return seconds * (1_000_000 if micros else 1_000)


def csv_row(timestamp, open_price="100", high="102", low="99", close="101", volume="3"):
    close_time = timestamp + (59_999_999 if timestamp >= 10**15 else 59_999)
    return [str(timestamp), open_price, high, low, close, volume, str(close_time), "0", "1", "0", "0", "0"]


def archive_for(day="2025-01-01"):
    rows = [csv_row(open_time(day, minute=i, micros=day >= "2025-01-01")) for i in (0, 1, 3)]
    text = "\n".join(",".join(row) for row in rows) + "\n"
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr(f"BTCUSDT-1m-{day}.csv", text)
    body = stream.getvalue()
    checksum = f"{hashlib.sha256(body).hexdigest()}  BTCUSDT-1m-{day}.zip\n".encode()
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
        if timeout != 15:
            raise AssertionError("HTTP timeout must be finite")
        with self.guard:
            self.calls.append(request.full_url)
        if self.delay:
            time.sleep(self.delay)
        return FakeResponse(self.checksum if request.full_url.endswith(".CHECKSUM") else self.body)


class MinuteDataTests(unittest.TestCase):
    def test_parse_accepts_2025_microseconds_and_preserves_missing_minutes(self):
        rows = [csv_row(open_time(minute=minute, micros=True)) for minute in (0, 1, 3)]
        parsed = parse_archive_csv(("\n".join(",".join(row) for row in rows) + "\n").encode(), "BTCUSDT", "2025-01-01")
        self.assertEqual([row[0] for row in parsed], [open_time(minute=m, micros=False) // 1000 for m in (0, 1, 3)])
        self.assertEqual(len(parsed), 3)

    def test_parse_rejects_bad_ohlc_order_and_wrong_utc_day(self):
        bad_ohlc = csv_row(open_time(micros=True), high="98")
        with self.assertRaises(MinuteDataError):
            parse_archive_csv((",".join(bad_ohlc) + "\n").encode(), "BTCUSDT", "2025-01-01")
        duplicate = csv_row(open_time(micros=True))
        with self.assertRaises(MinuteDataError):
            parse_archive_csv((",".join(duplicate) + "\n" + ",".join(duplicate) + "\n").encode(), "BTCUSDT", "2025-01-01")
        wrong_day = csv_row(open_time("2024-12-31", 23, 59))
        with self.assertRaises(MinuteDataError):
            parse_archive_csv((",".join(wrong_day) + "\n").encode(), "BTCUSDT", "2025-01-01")

    def test_allowlist_and_utc_date_bounds(self):
        for symbol, day in (("LTCUSDT", "2025-01-01"), ("../BTCUSDT", "2025-01-01"), ("BTCUSDT", "2026-01-01"), ("BTCUSDT", "2025-02-30")):
            with self.subTest(symbol=symbol, day=day), self.assertRaises(MinuteDataError):
                MinuteDataService.validate_request(symbol, day)

    def test_checksum_cache_and_corrupt_cache_redownload(self):
        opener = FakeOpener()
        with tempfile.TemporaryDirectory() as directory:
            service = MinuteDataService(directory, opener)
            first = service.get_day("BTCUSDT", "2025-01-01")
            self.assertEqual(len(first["candles"]), 3)
            self.assertEqual(len(opener.calls), 2)
            self.assertEqual(service.get_day("BTCUSDT", "2025-01-01"), first)
            self.assertEqual(len(opener.calls), 2)
            cache = Path(directory) / "BTCUSDT" / "2025-01-01.json"
            tampered = json.loads(cache.read_text())
            tampered["candles"][0][1] = 999
            cache.write_text(json.dumps(tampered))
            restored = service.get_day("BTCUSDT", "2025-01-01")
            self.assertEqual(restored["candles"][0][1], 100)
            self.assertEqual(len(opener.calls), 4)

    def test_bad_archive_checksum_is_rejected(self):
        body, _ = archive_for()
        class BadChecksum:
            def __call__(self, request, timeout):
                if request.full_url.endswith(".CHECKSUM"):
                    return FakeResponse(("0" * 64 + "  BTCUSDT-1m-2025-01-01.zip\n").encode())
                return FakeResponse(body)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(MinuteDataError, "SHA256"):
                MinuteDataService(directory, BadChecksum()).get_day("BTCUSDT", "2025-01-01")
            self.assertFalse((Path(directory) / "BTCUSDT" / "2025-01-01.json").exists())

    def test_same_day_concurrent_calls_download_once(self):
        opener = FakeOpener(delay=0.02)
        with tempfile.TemporaryDirectory() as directory:
            service = MinuteDataService(directory, opener)
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: service.get_day("BTCUSDT", "2025-01-01"), range(6)))
            self.assertTrue(all(result == results[0] for result in results))
            self.assertEqual(len(opener.calls), 2)

    def test_api_is_loopback_only_json_nostore_and_allowlisted(self):
        class Service:
            def get_day(self, symbol, day):
                MinuteDataService.validate_request(symbol, day)
                return {"symbol": symbol, "date": day, "interval": 60, "candles": [[1735689600, 1, 2, 1, 2, 3]],
                        "source": {"sha256": "0" * 64}}

        with tempfile.TemporaryDirectory() as cache:
            server = create_server("127.0.0.1", 0, PROJECT_DIR / "dist", cache, Service())
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_address[1]}/api/v1/minutes/BTCUSDT/2025-01-01"
                with urllib.request.urlopen(url, timeout=2) as response:
                    self.assertIn("no-store", response.headers["Cache-Control"])
                    self.assertEqual(json.loads(response.read())["interval"], 60)
                bad_symbol = url.replace("BTCUSDT", "LTCUSDT")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(bad_symbol, timeout=2)
                self.assertEqual(error.exception.code, 400)
                self.assertIn("no-store", error.exception.headers["Cache-Control"])
                with self.assertRaises(Exception):
                    urllib.request.urlopen(url.replace("BTCUSDT", "../../etc/passwd"), timeout=2)
            finally:
                server.shutdown()
                server.server_close()
            with self.assertRaises(ValueError):
                create_server("0.0.0.0", 0, PROJECT_DIR / "dist", cache, Service())


if __name__ == "__main__":
    unittest.main()
