@echo off
setlocal enabledelayedexpansion
title Dashboard Agent - One-Click Start
cd /d "%~dp0"

REM =============================================================
REM  Per-machine API key.
REM  On first run a RANDOM key is generated and persisted to
REM  agent-config.json (a repo-public shared default made every
REM  unedited clone run the SAME identity — paired machines then
REM  filter each other out of their device lists). To choose your
REM  own key, set "apiKey" in agent-config.json.
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

REM Sync database schema - ALWAYS (idempotent + additive: new columns like
REM repoUrl/notes land automatically after pulling updates).
if not exist "db" mkdir db
set DB_FULLPATH=!CD!\db\agent.db
set DATABASE_URL=file:!DB_FULLPATH!
echo [3/4] Syncing database schema
call npx --yes prisma db push --skip-generate
if errorlevel 1 (
    echo [WARN] prisma db push failed - continuing with the existing DB
) else (
    echo [OK] Database schema in sync
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

REM Resolve API Key: existing agent-config.json wins; first run generates
REM a random per-machine key. Known repo-committed shared keys are refused
REM (identity hygiene) so every machine gets a unique identity.
set AGENT_KEY=
if exist "agent-config.json" (
    for /f "delims=" %%k in ('node -e "try{const c=require('./agent-config.json');process.stdout.write(c.apiKey||'')}catch(e){}"') do set AGENT_KEY=%%k
    echo [INFO] API Key loaded from agent-config.json
)
if "!AGENT_KEY!"=="" set AGENT_KEY=REGEN
if "!AGENT_KEY!"=="remote-device-3101-key" set AGENT_KEY=REGEN
if "!AGENT_KEY!"=="my-secret-key-2024" set AGENT_KEY=REGEN
if "!AGENT_KEY!"=="test-api-key-12345" set AGENT_KEY=REGEN
if "!AGENT_KEY!"=="REGEN" (
    for /f "delims=" %%k in ('node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"') do set AGENT_KEY=%%k
    echo [INFO] No usable key in agent-config.json - generated a fresh per-machine key
    node -e "try{const f='agent-config.json';let c={};try{c=JSON.parse(require('fs').readFileSync(f,'utf8'))}catch(e){}c.apiKey=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(c,null,2))}" "!AGENT_KEY!"
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
echo [INFO] Key is FIXED. To change it, edit "apiKey" in agent-config.json
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
