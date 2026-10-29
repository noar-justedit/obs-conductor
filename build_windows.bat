@echo off
REM ==========================================================================
REM OBS Conductor - builds the Windows installer ON WINDOWS. Double-click it.
REM
REM Result: dist\OBSConductor-Setup-X.Y.Z.exe   (Windows 10 / 11, 64-bit)
REM
REM Nothing to install beforehand but NSIS (the installer maker): the script
REM offers to install it with winget when it is missing. The Node.js runtime
REM is downloaded from nodejs.org (version fixed in scripts\build_common.sh)
REM and checked against nodejs.org's SHA-256 fingerprint.
REM
REM Same result as build_windows.command on a Mac. Not signed for Windows:
REM SmartScreen shows "Windows protected your PC" the first time.
REM ==========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

for /f "tokens=2 delims==" %%v in ('findstr /b /c:"NODE_VERSION=" scripts\build_common.sh') do set "NODEV=%%~v"
if not defined NODEV ( echo [ERROR] Node.js version not found in scripts\build_common.sh & goto :end )

set "CACHE=%~dp0build\cache"
set "NAME=node-v%NODEV%-win-x64"
set "NODEDIR=%CACHE%\%NAME%"

if exist "%NODEDIR%\node.exe" goto :build

echo === Downloading Node.js %NODEV% ===
if not exist "%CACHE%" mkdir "%CACHE%"
curl.exe -fsSL "https://nodejs.org/dist/v%NODEV%/SHASUMS256.txt" -o "%CACHE%\SHASUMS256-v%NODEV%.txt"
if errorlevel 1 ( echo [ERROR] Could not reach nodejs.org & goto :end )
curl.exe -fL --progress-bar "https://nodejs.org/dist/v%NODEV%/%NAME%.zip" -o "%CACHE%\%NAME%.zip"
if errorlevel 1 ( echo [ERROR] Download of %NAME%.zip failed & goto :end )

set "WANT="
for /f "tokens=1" %%h in ('findstr /c:"%NAME%.zip" "%CACHE%\SHASUMS256-v%NODEV%.txt"') do set "WANT=%%h"
set "GOT="
for /f "skip=1 tokens=*" %%h in ('certutil -hashfile "%CACHE%\%NAME%.zip" SHA256') do if not defined GOT set "GOT=%%h"
set "GOT=%GOT: =%"
if not defined WANT ( echo [ERROR] %NAME%.zip is not in nodejs.org's list & goto :end )
if /i not "%GOT%"=="%WANT%" (
  echo [ERROR] %NAME%.zip does not match nodejs.org's fingerprint - deleted, run the build again
  del "%CACHE%\%NAME%.zip"
  goto :end
)
tar -xf "%CACHE%\%NAME%.zip" -C "%CACHE%"
if errorlevel 1 ( echo [ERROR] Could not unpack Node.js & goto :end )

:build
"%NODEDIR%\node.exe" "%~dp0scripts\build_windows.js"

:end
echo.
pause
