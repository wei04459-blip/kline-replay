#!/usr/bin/env python3
"""Small local-only static server with a stable identity header."""
import argparse
import hashlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

APP_ID = "com.yuwan.local.kline-replay"


class Handler(SimpleHTTPRequestHandler):
    server_version = "KlineReplayLocal/1.0"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        self.asset_version = kwargs.pop("asset_version")
        super().__init__(*args, **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
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
                body = body.replace(b"'./engine.mjs'", f"'./engine.mjs?v={self.asset_version}'".encode())
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(file_name))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        path = urlsplit(self.path).path.lower()
        if path.endswith((".html", ".mjs", ".js", ".css")) or path in ("/", ""):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")

        self.send_header("X-Kline-Replay-App", APP_ID)
        super().end_headers()


parser = argparse.ArgumentParser()
parser.add_argument("--bind", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8765)
parser.add_argument("--directory", required=True)
args = parser.parse_args()
version_digest = hashlib.sha256()
for name in ("index.html", "app.mjs", "style.css", "engine.mjs"):
    version_digest.update((Path(args.directory) / name).read_bytes())
asset_version = version_digest.hexdigest()[:16]
handler = partial(Handler, directory=args.directory, asset_version=asset_version)
server = ThreadingHTTPServer((args.bind, args.port), handler)
server.serve_forever()
