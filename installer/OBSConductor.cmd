@echo off
REM Starts OBS Conductor (installed copy). This window is the app running:
REM close it to stop the app. Add --simulate to try it without OBS.
title OBS Conductor
"%~dp0OBSConductor.exe" "%~dp0app\src\main.js" %*
if errorlevel 1 pause
