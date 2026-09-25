#!/usr/bin/env python3
"""Build a portable local macOS app bundle without launching it."""
from pathlib import Path
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "build"
OUTPUT_APP = OUTPUT_DIR / "K线回放.app"
DIST_FILES = (
    "index.html",
    "app.mjs",
    "style.css",
    "engine.mjs",
    "minute-data.mjs",
    "drawings.mjs",
    "review-export.mjs",
    "review-report.mjs",
    "review-recorder.mjs",
    "data/BTCUSDT.json",
    "data/ETHUSDT.json",
    "vendor/charts.mjs",
    "vendor/LICENSE",
    "vendor/NOTICE",
)
EXECUTABLES = (
    "MacOS/K线回放",
    "Resources/停止服务.command",
)


def main():
    if sys.platform != "darwin":
        raise SystemExit("此打包脚本需要 macOS 的 sips/iconutil 工具。")
    if OUTPUT_APP.exists():
        raise SystemExit(f"输出已存在，为避免覆盖而停止：{OUTPUT_APP}")

    missing = [str(ROOT / "dist" / name) for name in DIST_FILES if not (ROOT / "dist" / name).is_file()]
    if missing:
        raise SystemExit("缺少必需的正式资源：\n" + "\n".join(missing))
    templates = ROOT / "macos" / "Contents"
    if not (templates / "Info.plist").is_file():
        raise SystemExit(f"缺少 macOS 应用模板：{templates}")
    iconset = ROOT / "assets" / "K线回放.iconset"
    if not iconset.is_dir():
        raise SystemExit(f"缺少图标源文件：{iconset}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    temporary_parent = Path(tempfile.mkdtemp(prefix=".K线回放-build-", dir=OUTPUT_DIR))
    app = temporary_parent / "K线回放.app"
    try:
        contents = app / "Contents"
        shutil.copytree(
            templates,
            contents,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
        )
        shutil.copy2(ROOT / "README.md", contents / "Resources" / "README.md")
        for name in DIST_FILES:
            target = contents / "Resources" / "dist" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "dist" / name, target)

        shutil.copy2(ROOT / "assets" / "K线回放.png", contents / "Resources" / "AppIcon.png")
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(contents / "Resources" / "AppIcon.icns")],
            check=True,
        )
        with (contents / "Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("CFBundleIdentifier") != "com.yuwan.local.kline-replay":
            raise ValueError("应用模板的 Bundle ID 与本地服务标识不一致。")
        for relative in EXECUTABLES:
            path = contents / relative
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        os.replace(app, OUTPUT_APP)
        temporary_parent.rmdir()
    except BaseException:
        shutil.rmtree(temporary_parent, ignore_errors=True)
        raise

    print(f"已创建：{OUTPUT_APP}")
    print(f"包含正式资源：{len(DIST_FILES)} 个")
    print("应用没有启动；请将生成的 .app 手动复制到需要的位置。")


if __name__ == "__main__":
    main()
