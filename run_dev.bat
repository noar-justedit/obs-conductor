@echo off
REM OBS Conductor - run from the sources on Windows, without building.
REM   run_dev.bat              drives the OBS running on this PC
REM   run_dev.bat --simulate   fake OBS, no OBS needed
REM Then add http://localhost:8090/ in OBS > Docks > Custom Browser Docks,
REM or open it in a browser. Ctrl+C to stop.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found - install the LTS version from https://nodejs.org
    pause
    exit /b 1
)
if not exist node_modules (
    echo === First run: installing dependencies ===
    call npm ci --omit=dev --no-audit --no-fund || (pause & exit /b 1)
)
node src\main.js %*
pause
