@echo off
REM ============================================
REM  Dashboard Agent - Windows Service Wrapper
REM ============================================
REM
REM  Run the agent as a background service on Windows.
REM  The agent will continue running after you close
REM  this window.
REM
REM  To stop: use stop-service.bat or Task Manager
REM

cd /d "%~dp0"

set PORT=%1
set USER_KEY=%2

if "%PORT%"=="" set PORT=3100

set DATABASE_URL=file:%cd%\db\agent.db

REM Schema self-heal (idempotent + additive; non-fatal on failure).
call npx prisma db push
if errorlevel 1 echo [WARN] prisma db push failed - continuing with the existing DB

set DATABASE_URL=file:%cd%\db\agent.db

echo Starting Dashboard Agent as background service...
echo Port: %PORT%, API Key: auto (persisted key or fresh random - see agent console)

if "%USER_KEY%"=="" (
  start "Dashboard Agent" /B npx tsx index.ts --port %PORT%
) else (
  start "Dashboard Agent" /B npx tsx index.ts --port %PORT% --apiKey %USER_KEY%
)

echo.
echo Agent started in background.
echo To stop it, run: stop-service.bat
echo Or find "Dashboard Agent" in Task Manager.
