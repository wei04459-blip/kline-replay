#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "Contents" ]; then
  RESOURCES_DIR="$SCRIPT_DIR"
elif [ -d "$SCRIPT_DIR/K线回放.app/Contents/Resources" ]; then
  RESOURCES_DIR="$SCRIPT_DIR/K线回放.app/Contents/Resources"
else
  /usr/bin/osascript -e 'display alert "K线回放" message "没有找到应用程序包，未停止任何进程。" as critical' >/dev/null 2>&1 || true
  exit 1
fi

APP_ID="com.yuwan.local.kline-replay"
KLINE_PORT=8765
DIST_DIR="$RESOURCES_DIR/dist"
PID_FILE="/tmp/${APP_ID}-$(id -u)-${KLINE_PORT}.pid"
if [ ! -f "$PID_FILE" ]; then
  /usr/bin/osascript -e 'display notification "没有找到启动器记录的本地服务。" with title "K线回放"' >/dev/null 2>&1 || true
  exit 0
fi

KLINE_SERVER_PID=$(cat "$PID_FILE")
if ! [[ "$KLINE_SERVER_PID" =~ ^[0-9]+$ ]]; then
  /usr/bin/osascript -e 'display alert "K线回放" message "PID 记录无效，未停止任何进程。" as critical' >/dev/null 2>&1 || true
  exit 1
fi

if /usr/bin/python3 - "$KLINE_SERVER_PID" "$RESOURCES_DIR/serve.py" "$KLINE_PORT" "$DIST_DIR" "$PID_FILE" <<'PY'
import os
import signal
import subprocess
import sys
import time

pid, script, port, directory, pid_file = int(sys.argv[1]), *sys.argv[2:]
expected = f"{script} --bind 127.0.0.1 --port {port} --directory {directory}"

def command_line():
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""

command = command_line()
if not command:
    os.unlink(pid_file)
    print("服务已停止。")
    raise SystemExit(0)
if not command.endswith(expected):
    print("进程命令与本应用不匹配，未发送停止信号。")
    raise SystemExit(1)
os.kill(pid, signal.SIGTERM)
for _ in range(50):
    time.sleep(0.1)
    command = command_line()
    if not command:
        os.unlink(pid_file)
        print("服务已停止。")
        raise SystemExit(0)
    if not command.endswith(expected):
        try:
            os.unlink(pid_file)
        except FileNotFoundError:
            pass
        print("旧服务已退出；新占用的 PID 未被操作。")
        raise SystemExit(0)
print("服务仍在运行，未强制结束。")
raise SystemExit(1)
PY
then
  RESULT=0
else
  RESULT=$?
  /usr/bin/osascript -e 'display alert "K线回放" message "停止失败或服务仍在运行；未强制结束进程。" as critical' >/dev/null 2>&1 || true
fi
exit "$RESULT"
