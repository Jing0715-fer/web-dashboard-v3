@echo off
title Dashboard Agent
cd /d "%~dp0"

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)

:: Set default config
set AGENT_PORT=3100
set AGENT_API_KEY=
set AGENT_NAME=%COMPUTERNAME%

:: Parse arguments
:parse_args
if "%~1"=="" goto end_parse
if /i "%~1"=="--port" (
    set AGENT_PORT=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--apiKey" (
    set AGENT_API_KEY=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--name" (
    set AGENT_NAME=%~2
    shift
    shift
    goto parse_args
)
shift
goto parse_args
:end_parse

:: Set database path
set DATABASE_URL=file:%~dp0db\agent.db

:: Ensure db directory exists
if not exist "%~dp0db" mkdir "%~dp0db"

:: Check if first run (need npm install)
if not exist "%~dp0node_modules" (
    echo [Agent] First run - installing dependencies...
    call npm install --production
    echo [Agent] Dependencies installed.
)

:: Generate API key if not provided
if "%AGENT_API_KEY%"=="" (
    for /f "delims=" %%a in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set AGENT_API_KEY=%%a
    echo.
    echo ============================================
    echo   Generated API Key (SAVE THIS!):
    echo   %AGENT_API_KEY%
    echo ============================================
    echo.
)

:: Start the agent
echo [Agent] Starting Dashboard Agent on port %AGENT_PORT%...
echo [Agent] Name: %AGENT_NAME%
echo [Agent] Press Ctrl+C to stop
echo.

node agent.js --port %AGENT_PORT% --apiKey %AGENT_API_KEY% --name "%AGENT_NAME%"

pause
