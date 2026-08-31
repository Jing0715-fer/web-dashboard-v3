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
set API_KEY=%2

if "%PORT%"=="" set PORT=3100
if "%API_KEY%"=="" set API_KEY=test-api-key-12345

set DATABASE_URL=file:%cd%\db\agent.db

echo ========================================
echo  Dashboard Agent for Windows
echo ========================================
echo  Port:    %PORT%
echo  API Key: %API_KEY%
echo  DB:      %DATABASE_URL%
echo  Logs:    %APPDATA%\dashboard-agent-logs
echo ========================================
echo.

npx tsx index.ts --port %PORT% --apiKey %API_KEY%
