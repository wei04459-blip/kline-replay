#!/usr/bin/env python3
from __future__ import annotations
"""Small local-only static server with a stable identity header."""
import argparse
import hashlib
import ipaddress
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
from urllib.parse import urlsplit

from minute_data import MinuteDataError, MinuteDataService, MinuteDataUnavailable

APP_ID = "com.yuwan.local.kline-replay"


class Handler(SimpleHTTPRequestHandler):
    server_version = "KlineReplayLocal/1.0"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        self.asset_version = kwargs.pop("asset_version")
        super().__init__(*args, **kwargs)

    def do_GET(self):
        parsed_url = urlsplit(self.path)
        path = parsed_url.path
        if path.startswith("/api/"):
            self._handle_api(path, parsed_url.query)
            return
        if path in ("/", "/index.html", "/app.mjs"):
            file_name = "index.html" if path in ("/", "/index.html") else "app.mjs"
            file_path = Path(self.directory) / file_name
            try:
                body = file_path.read_bytes()
            except OSError:
                self.send_error(404, "File not found")
                return
            if file_name == "index.html":
                body = body.replace(b"./style.css", f"./style.css?v={self.asset_version}".encode())
                body = body.replace(b"./app.mjs", f"./app.mjs?v={self.asset_version}".encode())
            else:
                pattern = re.compile(rb"(['\"])[.]\/(engine|minute-data)[.]mjs\1")
                body = pattern.sub(lambda match: match.group(1) + b"./" + match.group(2) + b".mjs?v=" + self.asset_version.encode() + match.group(1), body)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(file_name))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def _handle_api(self, path: str, query: str) -> None:
        match = re.fullmatch(r"/api/v1/minutes/([^/]+)/([^/]+)", path)
        if not match or query:
            self._send_json(404, {"error": "分钟行情接口路径无效。"})
            return
        try:
            MinuteDataService.validate_request(*match.groups())
        except MinuteDataError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        try:
            payload = self.server.minute_service.get_day(*match.groups())
        except MinuteDataUnavailable as exc:
            self._send_json(404, {"error": str(exc)})
            return
        except MinuteDataError as exc:
            self._send_json(502, {"error": str(exc)})
            return
        except Exception:
            self._send_json(502, {"error": "读取分钟行情失败，请检查本地缓存或网络后重试。"})
            return
        self._send_json(200, {key: value for key, value in payload.items() if key != "cache_sha256"})

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        path = urlsplit(self.path).path.lower()
        if path.endswith((".html", ".mjs", ".js", ".css")) or path in ("/", ""):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")

        self.send_header("X-Kline-Replay-App", APP_ID)
        super().end_headers()


def create_server(bind: str, port: int, directory: str | Path, cache_directory: str | Path | None = None,
                  minute_service: MinuteDataService | None = None) -> ThreadingHTTPServer:
    try:
        bind_address = ipaddress.ip_address(bind)
    except ValueError as exc:
        raise ValueError("服务只允许绑定 127.0.0.1。") from exc
    if bind_address != ipaddress.IPv4Address("127.0.0.1"):
        raise ValueError("服务只允许绑定 127.0.0.1。")
    version_digest = hashlib.sha256()
    for name in ("index.html", "app.mjs", "style.css", "engine.mjs", "minute-data.mjs"):
        path = Path(directory) / name
        if path.is_file():
            version_digest.update(name.encode())
            version_digest.update(path.read_bytes())
    asset_version = version_digest.hexdigest()[:16]
    handler = partial(Handler, directory=str(directory), asset_version=asset_version)
    server = ThreadingHTTPServer((bind, port), handler)
    server.minute_service = minute_service or MinuteDataService(cache_directory)
    return server


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--cache-directory", default=None)
    args = parser.parse_args()
    try:
        server = create_server(args.bind, args.port, args.directory, args.cache_directory)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    server.serve_forever()


if __name__ == "__main__":
    main()
