@echo off
setlocal EnableExtensions
title Web Dashboard - port 3000
REM ============================================
REM  Web Dashboard - Windows Start Script
REM ============================================
REM
REM  Starts the dashboard dev server on http://localhost:3000
REM
REM  First run:  installs dependencies (npm), creates .env, inits the DB.
REM              Needs internet; takes a few minutes.
REM  Later runs: fast start. Auto re-runs npm install after a `git pull`
REM              changed package.json (timestamp stamp check).
REM
REM  Requirements: Node.js 20.9+  (https://nodejs.org/)
REM  Stop:         Ctrl+C in this window
REM
REM  Separate agent script: start-agent.bat 3101

cd /d "%~dp0"

REM ---------- [1/5] Node.js check ----------
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found. Install Node 20.9+ from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODEV=%%v"
set "NODEMAJOR=%NODEV:~1,2%"
if %NODEMAJOR% LSS 20 (
  echo ERROR: Node.js 20.9+ required, found %NODEV%. Upgrade from https://nodejs.org/
  pause
  exit /b 1
)
echo [1/5] Node.js %NODEV% OK

REM ---------- [2/5] Already-running guard ----------
netstat -an | findstr /C:":3000 " | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [2/5] Port 3000 is already LISTENING - assuming the dashboard is running.
  echo         Opening http://localhost:3000
  echo         ^(If that is NOT the dashboard, stop the other app and re-run.^)
  start http://localhost:3000
  pause
  exit /b 0
)
echo [2/5] Port 3000 free

REM ---------- [3/5] Dependencies ----------
REM Re-install when node_modules is missing OR package.json changed since the
REM last install (e.g. after git pull). node_modules\.install-stamp records
REM the last successful install time.
set "STAMP=node_modules\.install-stamp"
set "NEED_INSTALL=1"
if exist "%STAMP%" (
  REM exit 2 = package.json newer than stamp (install needed)
  powershell -NoProfile -Command "if((Get-Item 'package.json').LastWriteTime -gt (Get-Item '%STAMP%').LastWriteTime){exit 2}else{exit 0}" >nul 2>nul
  if errorlevel 2 (set "NEED_INSTALL=1") else (set "NEED_INSTALL=0")
)
if "%NEED_INSTALL%"=="1" (
  echo [3/5] Installing dependencies - first run takes a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo ERROR: npm install failed - see the messages above.
    pause
    exit /b 1
  )
  if not exist "node_modules" mkdir "node_modules"
  type nul > "%STAMP%"
) else (
  echo [3/5] Dependencies up to date - skipping install
)

REM ---------- [4/5] .env + database ----------
set "ROOTFWD=%cd:\=/%"
if not exist ".env" (
  echo [4/5] Creating .env with a local SQLite database path...
  > .env echo DATABASE_URL=file:%ROOTFWD%/db/custom.db
  >>.env echo.
  >>.env echo # Optional - override the auto-created admin login ^(admin@dashboard.local / admin123456^):
  >>.env echo # ADMIN_EMAIL=admin@dashboard.local
  >>.env echo # ADMIN_PASSWORD=admin123456
)
if not exist "db" mkdir "db"
echo [4/5] Syncing database schema...
call npx prisma db push
if errorlevel 1 (
  echo ERROR: prisma db push failed - check DATABASE_URL inside .env
  pause
  exit /b 1
)

REM ---------- [5/5] Start ----------
set "NODE_ENV="
echo.
echo ========================================
echo   Web Dashboard
echo   URL:   http://localhost:3000
echo   Login: admin@dashboard.local / admin123456
echo   Stop:  Ctrl+C in this window
echo ========================================
echo.

REM Open the browser once the server is likely up (cosmetic - if it opens too
REM early just refresh; first Turbopack compile can take a while)
start "" /min cmd /c "ping -n 12 127.0.0.1 >nul & start http://localhost:3000"

call npx next dev -p 3000
