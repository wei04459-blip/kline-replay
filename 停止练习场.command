#!/bin/bash
set -eu

cd "$(dirname "$0")"
KLINE_PORT=8765
KLINE_PID_FILE="/tmp/kline-practice-$(id -u)-${KLINE_PORT}.pid"
SERVE_SCRIPT="$PWD/macos/Contents/Resources/serve.py"
DIST_DIR="$PWD/dist"

if [ ! -f "$KLINE_PID_FILE" ]; then
  echo "没有找到启动器记录的练习场服务。手动在终端启动的服务请回到该终端按 Control-C。"
  read -r -p "按回车键关闭此窗口。" _
  exit 0
fi

KLINE_SERVER_PID=$(cat "$KLINE_PID_FILE")
if ! [[ "$KLINE_SERVER_PID" =~ ^[0-9]+$ ]]; then
  echo "PID 记录格式无效，未停止任何进程。请检查 $KLINE_PID_FILE。"
  read -r -p "按回车键关闭此窗口。" _
  exit 1
fi

if /usr/bin/python3 - "$KLINE_SERVER_PID" "$SERVE_SCRIPT" "$KLINE_PORT" "$DIST_DIR" "$KLINE_PID_FILE" <<'PY'
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

cmd = command_line()
if not cmd:
    os.unlink(pid_file)
    print("启动器记录的服务已经停止。")
    raise SystemExit(0)
if not cmd.endswith(expected):
    print("PID 对应的进程命令与本练习场不匹配，未停止任何进程；PID 记录已保留供检查。")
    raise SystemExit(1)

os.kill(pid, signal.SIGTERM)
for _ in range(50):
    time.sleep(0.1)
    cmd = command_line()
    if not cmd:
        os.unlink(pid_file)
        print("练习场服务已停止。")
        raise SystemExit(0)
    if not cmd.endswith(expected):
        print("原服务已退出或 PID 已被其他进程复用；停止器没有对新进程采取操作。")
        try:
            os.unlink(pid_file)
        except FileNotFoundError:
            pass
        raise SystemExit(0)

print("服务收到停止信号但仍在运行；未强制结束，请稍后重试。")
raise SystemExit(1)
PY
then
  RESULT=0
else
  RESULT=$?
  read -r -p "按回车键关闭此窗口。" _
fi
exit "$RESULT"
