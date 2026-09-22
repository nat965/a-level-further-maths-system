@echo off
rem Fallback launcher for Windows: use this if double-clicking "Revision Tracker.pyw" doesn't work.
cd /d "%~dp0"
where pyw >nul 2>nul
if %errorlevel%==0 (
  start "" pyw -3 -m revision_tracker
  exit /b 0
)
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw -m revision_tracker
  exit /b 0
)
echo.
echo Revision Tracker needs Python 3.9 or newer.
echo Install it from https://www.python.org/downloads/windows/
echo (tick "Add python.exe to PATH" in the installer), then try again.
echo.
pause
