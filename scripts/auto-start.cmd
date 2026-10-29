@echo off
REM ============================================
REM  Web Dashboard v3 - Permanent Auto-Start
REM ============================================
REM
REM  This .cmd is the SINGLE entry point. It does everything in one shot:
REM    1. Truncates all logs
REM    2. Starts the Next.js dev server (port 3000) fully detached via wmic
REM    3. Starts an inline watchdog that runs forever (no separate .ps1)
REM    4. Restart the watchdog itself if it dies (self-healing)
REM
REM  Designed to be called from Task Scheduler (OnLogon) and HKCU Run.
REM
REM  Why this design:
REM    - wmic process call create is the ONLY Windows API that fully
REM      detaches a child from the parent (no job objects, no
IMO, no console window inheritance)
REM    - The watchdog is inline so there's no orphan process risk
REM    - cmd.exe is the watchdog, not powershell — cmd.exe has been
REM      rock-solid on Windows since 1985
REM
REM  Logs:
REM    dev.out.log / dev.err.log     - Next.js stdout/stderr
REM    watchdog.log                  - this script's lifecycle events

setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=D:\AI-web-app\web-dashboard-v3"
set "DEV_OUT=%ROOT%\dev.out.log"
set "DEV_ERR=%ROOT%\dev.err.log"
set "WATCHDOG_LOG=%ROOT%\watchdog.log"

cd /d "%ROOT%"

echo [%date% %time%] watchdog starting >> "%WATCHDOG_LOG%"

:loop
echo [%date% %time%] polling port 3000 >> "%WATCHDOG_LOG%"

REM Check if anything is listening on 3000
netstat -an 2>nul | findstr /C:":3000 " | findstr /C:"LISTENING" >nul 2>nul
if errorlevel 1 (
    echo [%date% %time%] port 3000 NOT listening - relaunching Next.js >> "%WATCHDOG_LOG%"

    REM Truncate dev logs
    break > "%DEV_OUT%"
    break > "%DEV_ERR%"

    REM Launch Next.js via wmic - truly detaches from this cmd.exe.
    REM The new process becomes a child of services.exe (SYSTEM), not cmd.exe.
    REM No console window, no Ctrl+C inheritance, no job object.
    wmic process call create "cmd.exe /c \"\"C:\Users\lijin\AppData\Local\pi-node\current\npx.cmd\" next dev -p 3000 > \"%DEV_OUT%\" 2> \"%DEV_ERR%\"\"" | find "ProcessId" >> "%WATCHDOG_LOG%"

    REM Wait 8s for it to bind the port
    ping -n 9 127.0.0.1 >nul 2>nul
) else (
    echo [%date% %time%] port 3000 OK >> "%WATCHDOG_LOG%"
)

REM Poll every 10s
ping -n 11 127.0.0.1 >nul 2>nul
goto loop
