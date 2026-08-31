@echo off
setlocal enabledelayedexpansion
title Dashboard Agent - Stop
cd /d "%~dp0"

echo.
echo Stopping Dashboard Agent...
echo.

set STOPPED=0

:: Method 1: PID file
if exist "agent.pid" (
    for /f "usebackq" %%p in ("agent.pid") do (
        tasklist /FI "PID eq %%p" 2>nul | findstr /C:"%%p" >nul
        if not errorlevel 1 (
            echo [INFO] Killing PID %%p from agent.pid...
            taskkill /F /PID %%p >nul 2>&1
            set STOPPED=1
        )
    )
    del "agent.pid" >nul 2>&1
)

:: Method 2: Find by port (try 3100-3109)
for /L %%P in (3100,1,3109) do (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo [INFO] Killing process on port %%P ^(PID %%p^)...
        taskkill /F /PID %%p >nul 2>&1
        set STOPPED=1
    )
)

:: Method 3: Find by window title
taskkill /F /FI "WINDOWTITLE eq Dashboard Agent*" 2>nul >nul

if "!STOPPED!"=="1" (
    echo.
    echo [OK] Agent stopped.
) else (
    echo [INFO] No running agent found.
)
echo.
