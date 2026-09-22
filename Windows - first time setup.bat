@echo off
rem One-off setup: checks Python and puts a "Revision Tracker" shortcut on your Desktop.
cd /d "%~dp0"
echo Setting up Revision Tracker...
echo.

set "PYEXE="
for /f "delims=" %%i in ('py -3 -c "import sys, sqlite3; assert sys.version_info >= (3, 9); print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if not defined PYEXE (
  for /f "delims=" %%i in ('python -c "import sys, sqlite3; assert sys.version_info >= (3, 9); print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
)
if not defined PYEXE (
  echo Python 3.9 or newer was not found.
  echo.
  echo 1. Download Python from https://www.python.org/downloads/windows/
  echo 2. In the installer, tick "Add python.exe to PATH", then click Install Now.
  echo 3. Run this setup file again.
  echo.
  start "" "https://www.python.org/downloads/windows/"
  pause
  exit /b 1
)
echo Found Python: %PYEXE%

set "PYWEXE=%PYEXE:python.exe=pythonw.exe%"
if not exist "%PYWEXE%" set "PYWEXE=%PYEXE%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Revision Tracker.lnk');" ^
  "$s.TargetPath = '%PYWEXE%'; $s.Arguments = '-m revision_tracker'; $s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%~dp0assets\icon.ico'; $s.Description = 'Revision Tracker'; $s.Save()"
if %errorlevel%==0 (
  echo Created a "Revision Tracker" shortcut on your Desktop.
) else (
  echo Couldn't create the Desktop shortcut - you can still double-click "Revision Tracker.pyw".
)
echo.
echo Starting Revision Tracker...
start "" "%PYWEXE%" -m revision_tracker
echo Done. From now on just double-click the Desktop shortcut.
timeout /t 5 >nul
