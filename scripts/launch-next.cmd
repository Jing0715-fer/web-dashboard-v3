@echo off
REM ============================================
REM  Web Dashboard v3 - Launch Next.js (avoids PS tmp bug)
REM ============================================
REM
REM  Called from watchdog.ps1. We CANNOT use
REM    Start-Process -FilePath npx.cmd -ArgumentList @('next','dev',...)
REM  because PowerShell 5.1's array parser rejects anything with "tmp"
REM  in a token (Chinese locale error: "关键字:tmp").
REM
REM  Instead, invoke via cmd.exe /c with the whole command as a single
REM  string. cmd.exe doesn't care about "tmp".

cd /d "D:\AI-web-app\web-dashboard-v3"
"C:\Users\lijin\AppData\Local\pi-node\current\npx.cmd" next dev -p 3001 > "D:\AI-web-app\web-dashboard-v3\.next.bak3\dev.out.log" 2> "D:\AI-web-app\web-dashboard-v3\.next.bak3\dev.err.log"
