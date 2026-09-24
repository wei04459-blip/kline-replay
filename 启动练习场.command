#!/bin/bash
set -eu

cd "$(dirname "$0")"
APP_ID="com.yuwan.local.kline-replay"
KLINE_PORT=8765
KLINE_URL="http://127.0.0.1:${KLINE_PORT}/?launch=$(/bin/date +%s)-$$"
KLINE_PID_FILE="/tmp/kline-practice-$(id -u)-${KLINE_PORT}.pid"
SERVE_SCRIPT="$PWD/macos/Contents/Resources/serve.py"
DIST_DIR="$PWD/dist"

# If this port is already serving this app, reuse it. Never stop another process.
if /usr/bin/python3 - "$KLINE_URL" "$APP_ID" <<'PY'
import sys
from urllib.request import urlopen
try:
    with urlopen(sys.argv[1], timeout=2) as response:
        sys.exit(0 if response.headers.get("X-Kline-Replay-App") == sys.argv[2] else 1)
except Exception:
    sys.exit(1)
PY
then
  /usr/bin/open "$KLINE_URL"
  exit 0
fi

if /usr/sbin/lsof -nP -iTCP:"$KLINE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${KLINE_PORT} 已被其他服务占用，练习场没有启动，也没有更改该服务。"
  read -r -p "按回车键关闭此窗口。" _
  exit 1
fi

nohup /usr/bin/python3 "$SERVE_SCRIPT" --bind 127.0.0.1 --port "$KLINE_PORT" --directory "$DIST_DIR" \
  >/tmp/kline-practice-local-server.log 2>&1 </dev/null &
KLINE_SERVER_PID=$!
printf '%s\n' "$KLINE_SERVER_PID" >"$KLINE_PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if /usr/bin/python3 - "$KLINE_URL" "$APP_ID" <<'PY'
import sys
from urllib.request import urlopen
try:
    with urlopen(sys.argv[1], timeout=1) as response:
        sys.exit(0 if response.headers.get("X-Kline-Replay-App") == sys.argv[2] else 1)
except Exception:
    sys.exit(1)
PY
  then
    /usr/bin/open "$KLINE_URL"
    exit 0
  fi
  sleep 1
done

/usr/bin/python3 - "$KLINE_SERVER_PID" "$SERVE_SCRIPT" "$KLINE_PORT" "$DIST_DIR" "$KLINE_PID_FILE" <<'PY'
import os, signal, subprocess, sys
pid, script, port, directory, pid_file = int(sys.argv[1]), *sys.argv[2:]
command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout.strip()
expected = f"{script} --bind 127.0.0.1 --port {port} --directory {directory}"
if command.endswith(expected):
    os.kill(pid, signal.SIGTERM)
try: os.unlink(pid_file)
except FileNotFoundError: pass
PY
echo "练习场启动失败，请查看 /tmp/kline-practice-local-server.log。"
read -r -p "按回车键关闭此窗口。" _
exit 1
