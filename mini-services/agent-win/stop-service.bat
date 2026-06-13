@echo off
REM ============================================
REM  Dashboard Agent - Stop Background Service
REM ============================================

echo Stopping Dashboard Agent...

REM Find and kill node processes running our agent
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3100 ^| findstr LISTENING') do (
  echo Found agent process PID: %%a
  taskkill /PID %%a /T /F 2>nul
)

if errorlevel 1 (
  echo No agent process found on port 3100.
) else (
  echo Agent stopped successfully.
)
pause
