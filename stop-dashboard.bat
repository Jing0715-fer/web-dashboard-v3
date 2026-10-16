@echo off
setlocal EnableExtensions
REM ============================================
REM  Web Dashboard - Stop Script
REM ============================================
REM
REM  Stops the dashboard dev server - whether it was started visibly
REM  (start-dashboard.bat) or hidden (start-dashboard-silent.vbs).
REM
REM  Usage:  stop-dashboard.bat          (default port 3000)
REM          stop-dashboard.bat 3001    (custom port)

set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
  if not "%%p"=="0" (
    set "FOUND=1"
    echo Stopping PID %%p ^(port %PORT%^)...
    taskkill /PID %%p /T /F >nul 2>nul
  )
)

if "%FOUND%"=="" (
  echo No process is listening on port %PORT% - nothing to stop.
) else (
  echo Dashboard stopped.
)
pause
