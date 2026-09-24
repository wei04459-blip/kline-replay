#!/usr/bin/env python3
"""Small local-only static server with a stable identity header."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_ID = "com.yuwan.local.kline-replay"


class Handler(SimpleHTTPRequestHandler):
    server_version = "KlineReplayLocal/1.0"
    sys_version = ""

    def end_headers(self):
        self.send_header("X-Kline-Replay-App", APP_ID)
        super().end_headers()


parser = argparse.ArgumentParser()
parser.add_argument("--bind", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8765)
parser.add_argument("--directory", required=True)
args = parser.parse_args()
handler = partial(Handler, directory=args.directory)
server = ThreadingHTTPServer((args.bind, args.port), handler)
server.serve_forever()
