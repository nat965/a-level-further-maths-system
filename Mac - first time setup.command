#!/bin/bash
# One-off setup for macOS: checks Python, allows the launcher to run, and puts a
# "Revision Tracker" alias on your Desktop. Right-click > Open this file the first time.
cd "$(dirname "$0")" || exit 1
echo "Setting up Revision Tracker..."
echo

# Files downloaded from the internet are quarantined; the launcher is a local script.
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x "Revision Tracker.app/Contents/MacOS/RevisionTracker" "Mac - first time setup.command" 2>/dev/null

PY=""
for p in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [ -x "$p" ] && "$p" -c 'import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$p"; break; fi
done
if [ -z "$PY" ] && xcode-select -p >/dev/null 2>&1 && /usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  PY=/usr/bin/python3
fi
if [ -z "$PY" ]; then
  echo "Python 3.9 or newer was not found."
  echo
  echo "1. Download Python from https://www.python.org/downloads/macos/ and install it."
  echo "2. Run this setup file again."
  open "https://www.python.org/downloads/macos/"
  exit 1
fi
echo "Found Python: $PY ($("$PY" --version))"

osascript -e "tell application \"Finder\" to make alias file to POSIX file \"$PWD/Revision Tracker.app\" at desktop" >/dev/null 2>&1 \
  && echo "Created a \"Revision Tracker\" alias on your Desktop." \
  || echo "Couldn't create the Desktop alias - you can still double-click \"Revision Tracker\" in this folder."
echo
echo "Starting Revision Tracker..."
open "Revision Tracker.app"
echo "Done. From now on just double-click Revision Tracker. You can close this window."
