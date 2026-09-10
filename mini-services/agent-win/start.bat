@echo off
REM ============================================
REM  Dashboard Agent - Windows Start Script
REM ============================================
REM
REM  Usage:
REM    start.bat                    (use default port 3100 and API key)
REM    start.bat 3200 my-secret     (custom port and API key)
REM
REM  Prerequisites:
REM    - Node.js 18+ installed (https://nodejs.org/)
REM    - Run setup.bat first to install dependencies
REM

cd /d "%~dp0"

set PORT=%1
set USER_KEY=%2

if "%PORT%"=="" set PORT=3100

set DATABASE_URL=file:%cd%\db\agent.db

REM Schema self-heal: prisma db push is idempotent + additive, so new
REM columns (e.g. repoUrl/notes) land automatically after pulling updates.
REM Failure is non-fatal — the agent still starts with the existing DB.
call npx prisma db push
if errorlevel 1 echo [WARN] prisma db push failed - continuing with the existing DB

echo ========================================
echo  Dashboard Agent for Windows
echo ========================================
echo  Port:    %PORT%
if "%USER_KEY%"=="" (
  echo  API Key: ^(auto - persisted key or fresh random, see line below^)
) else (
  echo  API Key: %USER_KEY%
)
echo  DB:      %DATABASE_URL%
echo  Logs:    %APPDATA%\dashboard-agent-logs
echo ========================================
echo.

if "%USER_KEY%"=="" (
  npx tsx index.ts --port %PORT%
) else (
  npx tsx index.ts --port %PORT% --apiKey %USER_KEY%
)
