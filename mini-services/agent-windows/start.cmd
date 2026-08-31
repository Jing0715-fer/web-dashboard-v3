@echo off
setlocal enabledelayedexpansion
title Dashboard Agent - One-Click Start
cd /d "%~dp0"

REM =============================================================
REM  Fixed API Key - CHANGE THIS to your own secret.
REM  This Key is used every time you start the agent. The first
REM  launch also writes it into agent-config.json so other tools
REM  (Dashboard backend, scripts) can read it from there.
REM =============================================================
set DEFAULT_API_KEY=my-secret-key-2024
REM =============================================================

echo.
echo ============================================
echo   Dashboard Agent - One-Click Start
echo ============================================
echo.

REM Check Node
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not installed
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% detected
for /f "delims=" %%v in ('npm --version') do set NPM_VER=%%v
echo [OK] npm %NPM_VER% detected
echo.

REM npm mirror
call npm config get registry > "%~dp0.tmpreg.txt" 2>&1
findstr /I "npmmirror" "%~dp0.tmpreg.txt" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Setting npm mirror to npmmirror for faster install
    call npm config set registry https://registry.npmmirror.com
)
if exist "%~dp0.tmpreg.txt" del "%~dp0.tmpreg.txt" >nul 2>&1
echo.

REM Install deps
if not exist "node_modules\@prisma\client\index.js" (
    echo [1/4] Installing dependencies
    call npm install --production
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
) else (
    echo [1/4] Dependencies present
)
echo.

REM Prisma
set DB_FULLPATH=!CD!\db\agent.db
set DATABASE_URL=file:!DB_FULLPATH!
if not exist "db" mkdir db

REM Always (re)generate Prisma client to guarantee node_modules\.prisma\client exists.
REM npx --yes downloads prisma to a temp dir on every run and is slow / may fail offline,
REM so use the local install in node_modules\.bin instead.
echo [2/4] Generating Prisma client
if not exist "node_modules\.bin\prisma.cmd" (
    echo [ERROR] prisma CLI not found. Run "npm install" first.
    pause
    exit /b 1
)
call "node_modules\.bin\prisma.cmd" generate
if errorlevel 1 (
    echo [WARN] prisma generate via .bin failed, retrying with npx...
    call npx --no-install prisma generate
    if errorlevel 1 (
        echo [ERROR] prisma generate failed. Check network and try again.
        pause
        exit /b 1
    )
)
if not exist "node_modules\.prisma\client\default.js" (
    echo [ERROR] Prisma client not generated (node_modules\.prisma\client\default.js missing)
    pause
    exit /b 1
)
echo [OK] Prisma client ready
echo.

REM Database
if not exist "db\agent.db" (
    echo [3/4] Initializing database
    if not exist "db" mkdir db
    set DB_FULLPATH=!CD!\db\agent.db
    set DATABASE_URL=file:!DB_FULLPATH!
    call npx --yes prisma db push --skip-generate
    if errorlevel 1 (
        echo [WARN] prisma db push failed
    ) else (
        echo [OK] Database initialized
    )
) else (
    echo [3/4] Database exists
)
echo.

REM Stop old instance
if exist "agent.pid" (
    for /f "usebackq" %%p in ("agent.pid") do (
        tasklist /FI "PID eq %%p" 2>nul | findstr /C:"%%p" >nul
        if not errorlevel 1 (
            echo [INFO] Stopping PID %%p
            taskkill /F /PID %%p >nul 2>&1
        )
    )
    del "agent.pid" >nul 2>&1
)

REM Pick port
set FREE_PORT=3100
:port_loop
netstat -ano | findstr ":%FREE_PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    set /a FREE_PORT+=1
    if !FREE_PORT! lss 3110 goto port_loop
)
set AGENT_PORT=!FREE_PORT!
set AGENT_NAME=%COMPUTERNAME%

REM Resolve API Key: existing agent-config.json wins, else use DEFAULT_API_KEY
if exist "agent-config.json" (
    for /f "delims=" %%k in ('node -e "try{const c=require('./agent-config.json');process.stdout.write(c.apiKey||'')}catch(e){}"') do set AGENT_KEY=%%k
    if "!AGENT_KEY!"=="" set AGENT_KEY=%DEFAULT_API_KEY%
    echo [INFO] API Key loaded from agent-config.json
) else (
    set AGENT_KEY=%DEFAULT_API_KEY%
    echo [INFO] First run - saving default API Key to agent-config.json
    (
        echo {
        echo   "port": 3100^,
        echo   "apiKey": "%DEFAULT_API_KEY%"^,
        echo   "name": "%AGENT_NAME%"^,
        echo   "dbPath": "db\\agent.db"^,
        echo   "createdAt": "%DATE% %TIME%"^,
        echo   "version": "1.2.0"
        echo }
    ) > "agent-config.json"
)

echo.
echo ============================================
echo   Agent starting on port %AGENT_PORT%
echo   Name:   %AGENT_NAME%
echo   API Key: %AGENT_KEY%
echo ============================================
echo.
echo Health (no auth): http://localhost:%AGENT_PORT%/api/agent/health
echo Authorized calls need header:  Authorization: Bearer %AGENT_KEY%
echo.
echo [INFO] Key is FIXED. To change it, edit DEFAULT_API_KEY in start.cmd
echo [INFO] Or delete agent-config.json to re-trigger the save with a new default.
echo [INFO] Ctrl+C to stop.
echo.

(
    echo AGENT_PORT=%AGENT_PORT%
    echo AGENT_NAME=%AGENT_NAME%
    echo AGENT_KEY=%AGENT_KEY%
) > "%~dp0.agent-session.env"

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%AGENT_PORT%/api/agent/health"

set DB_FULLPATH=!CD!\db\agent.db
set DATABASE_URL=file:!DB_FULLPATH!
node agent.js --port %AGENT_PORT% --apiKey %AGENT_KEY% --name "%AGENT_NAME%"

if exist "agent.pid" del "agent.pid" >nul 2>&1
if exist ".agent-session.env" del ".agent-session.env" >nul 2>&1

echo.
echo [Agent] Stopped.
pause
