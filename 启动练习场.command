#!/bin/bash
set -eu

cd "$(dirname "$0")"
KLINE_PORT=8765
KLINE_URL="http://127.0.0.1:${KLINE_PORT}"
KLINE_PID_FILE="/tmp/kline-practice-$(id -u)-${KLINE_PORT}.pid"

# If this port is already serving this app, reuse it. Never stop another process.
if python3 - "$KLINE_URL" <<'PY'
import sys
from urllib.request import urlopen
try:
    body = urlopen(sys.argv[1], timeout=2).read().decode("utf-8", "replace")
    sys.exit(0 if '<div id="chart"></div>' in body and './app.mjs' in body else 1)
except Exception:
    sys.exit(1)
PY
then
  open "$KLINE_URL"
  exit 0
fi

if lsof -nP -iTCP:"$KLINE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${KLINE_PORT} 已被其他服务占用，练习场没有启动，也没有更改该服务。"
  read -r -p "按回车键关闭此窗口。" _
  exit 1
fi

nohup python3 -m http.server "$KLINE_PORT" --bind 127.0.0.1 --directory "$PWD/dist" \
  >/tmp/kline-practice-local-server.log 2>&1 </dev/null &
KLINE_SERVER_PID=$!
printf '%s\n' "$KLINE_SERVER_PID" >"$KLINE_PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if python3 - "$KLINE_URL" <<'PY'
import sys
from urllib.request import urlopen
try:
    body = urlopen(sys.argv[1], timeout=1).read().decode("utf-8", "replace")
    sys.exit(0 if '<div id="chart"></div>' in body and './app.mjs' in body else 1)
except Exception:
    sys.exit(1)
PY
  then
    open "$KLINE_URL"
    exit 0
  fi
  sleep 1
done

echo "练习场启动失败，请查看 /tmp/kline-practice-local-server.log。"
read -r -p "按回车键关闭此窗口。" _
exit 1
