@echo off
REM ============================================
REM  Dashboard Agent - Windows Setup Script
REM ============================================
REM
REM  Run this script once to install dependencies
REM  and initialize the database.
REM

cd /d "%~dp0"

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed. Please make sure Node.js 18+ is installed.
  echo Download from: https://nodejs.org/
  pause
  exit /b 1
)

echo [2/4] Installing tsx for TypeScript execution...
call npm install --save-dev tsx
if errorlevel 1 (
  echo WARNING: tsx install failed. Trying global install...
  call npm install -g tsx
)

echo [3/4] Initializing database...
set DATABASE_URL=file:%cd%\db\agent.db
call npx prisma db push
if errorlevel 1 (
  echo ERROR: Database initialization failed.
  pause
  exit /b 1
)

echo [4/4] Verifying setup...
if not exist "db\agent.db" (
  echo WARNING: Database file not found. Creating db directory...
  if not exist "db" mkdir db
  call npx prisma db push
)

echo.
echo ========================================
echo  Setup Complete!
echo ========================================
echo.
echo  To start the agent:
echo    start.bat
echo.
echo  To start with custom settings:
echo    start.bat 3200 your-api-key
echo.
echo  Then add this device to your Dashboard:
echo    IP:      Your Windows IP address
echo    Port:    3100 (or custom)
echo    API Key: test-api-key-12345 (or custom)
echo.
pause
