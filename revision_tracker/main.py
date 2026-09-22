"""Start the app: open the database, start the local server and open a window.

Double-click launchers call this. If the app is already running it just opens a new
window onto the running copy instead of starting a second one.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

from .db import Store, default_data_dir
from .server import APP_ID, App

DEFAULT_PORT = 8765
MIN_PYTHON = (3, 9)


def running_instance(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return json.load(r).get("app") == APP_ID
    except Exception:
        return False


def app_window_browser():
    """Chrome / Edge / Brave / Chromium, which can open a site as a standalone app window."""
    candidates = []
    if sys.platform == "darwin":
        for name, exe in (("Google Chrome", "Google Chrome"), ("Microsoft Edge", "Microsoft Edge"),
                          ("Brave Browser", "Brave Browser"), ("Chromium", "Chromium")):
            for root in ("/Applications", str(Path.home() / "Applications")):
                candidates.append(f"{root}/{name}.app/Contents/MacOS/{exe}")
    elif os.name == "nt":
        roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        for root in filter(None, roots):
            candidates += [os.path.join(root, r"Google\Chrome\Application\chrome.exe"),
                           os.path.join(root, r"Microsoft\Edge\Application\msedge.exe"),
                           os.path.join(root, r"BraveSoftware\Brave-Browser\Application\brave.exe")]
    else:
        candidates += [shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser",
                                                      "microsoft-edge")]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def open_window(url, mode):
    exe = app_window_browser() if mode == "app_window" else None
    if exe:
        try:
            kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
            if os.name == "nt":
                kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
            else:
                kwargs["start_new_session"] = True
            subprocess.Popen([exe, f"--app={url}", "--window-size=1320,860"], **kwargs)
            return
        except OSError:
            pass
    webbrowser.open(url)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Revision Tracker")
    ap.add_argument("--port", type=int, default=int(os.environ.get("REVISION_TRACKER_PORT", DEFAULT_PORT)))
    ap.add_argument("--data-dir", default=None, help="folder for the database and backups")
    ap.add_argument("--no-browser", action="store_true", help="don't open a window")
    ap.add_argument("--no-auto-exit", action="store_true", help="keep running with no window open")
    args = ap.parse_args(argv)

    if sys.version_info < MIN_PYTHON:
        sys.exit("Revision Tracker needs Python 3.9 or newer.")

    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "app.log"

    # pythonw / .app launches have no console: send output to the log file instead.
    if sys.stdout is None or sys.stderr is None or not sys.stdout.isatty():
        log_file = open(log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log_file

    def log(msg):
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)

    if running_instance(args.port):
        log("Already running; opening another window.")
        if not args.no_browser:
            open_window(f"http://127.0.0.1:{args.port}/", "app_window")
        return

    store = Store(data_dir)
    store.daily_backup()
    try:
        app = App(store, args.port, log, auto_exit=not args.no_auto_exit)
    except OSError:
        app = App(store, 0, log, auto_exit=not args.no_auto_exit)  # port taken by something else
    log(f"Revision Tracker running at {app.url} (data: {store.path})")
    if not args.no_browser:
        mode = store.settings().get("open_in", "app_window")
        threading.Thread(target=lambda: (time.sleep(0.3), open_window(app.url, mode)), daemon=True).start()
    try:
        app.serve()
    except KeyboardInterrupt:
        pass
    log("Stopped.")


if __name__ == "__main__":
    main()
