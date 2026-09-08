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

:: Regenerate the Prisma client + sync the DB schema (idempotent — new
:: columns like repoUrl/notes land automatically after pulling updates).
:: A stale generated client after a git pull was the agent-side twin of the
:: "Unknown argument repoUrl" dashboard bug: the in-process DDL fixes the
:: DB but NOT the client.
if exist "%~dp0node_modules\.bin\prisma.cmd" (
    echo [Agent] Generating Prisma client...
    call "%~dp0node_modules\.bin\prisma.cmd" generate
    echo [Agent] Syncing database schema...
    call npx --yes prisma db push --skip-generate
) else (
    echo [Agent] prisma CLI not found - skipping generate/db push
)

:: API key resolution — MUST stay stable across restarts:
::   CLI arg > persisted agent-config.json > fresh random (persisted).
:: The old script minted a NEW random key on every keyless launch, so each
:: restart churned the machine identity (heartbeat 400 "key unknown" ->
:: every proxied dashboard call 401 — the exact Task-21 failure mode).
if "%AGENT_API_KEY%"=="" (
    if exist "%~dp0agent-config.json" (
        for /f "delims=" %%a in ('node -e "try{const c=require('./agent-config.json');process.stdout.write(c.apiKey||'')}catch(e){}"') do set AGENT_API_KEY=%%a
        echo [Agent] API Key loaded from agent-config.json
    )
)
if "%AGENT_API_KEY%"=="" (
    for /f "delims=" %%a in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set AGENT_API_KEY=%%a
    echo [Agent] Generated a fresh per-machine API Key and saved it to agent-config.json
    node -e "try{const f='agent-config.json';let c={};try{c=JSON.parse(require('fs').readFileSync(f,'utf8'))}catch(e){}c.apiKey=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(c,null,2))}" "%AGENT_API_KEY%"
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
