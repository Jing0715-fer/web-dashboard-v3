@echo off
REM Detached dev launcher — keeps dev.log / dev.err.log in repo, no console window
cd /d "D:\AI-web-app\web-dashboard-v3"
setlocal
set "OUT=D:\AI-web-app\web-dashboard-v3\dev.log"
set "ERR=D:\AI-web-app\web-dashboard-v3\dev.err.log"

REM Turbopack's dev server can build an incomplete route tree at startup: some
REM App Router subtrees then answer with the HTML 404 page even though the
REM route.ts exists. A git pull does not emit a file event for unchanged files,
REM so it never self-heals, and a later restart can hit the same thing — so the
REM repair has to outlive the boot that needed it. The watcher below polls a
REM sentinel route and, only when it comes back as an unregistered HTML 404,
REM touches every route file to force re-registration of the missing subtrees.
REM It runs detached so this script keeps its foreground process model.
start "" /min cmd /c "node ""D:\AI-web-app\web-dashboard-v3\scripts\touch-routes.cjs"" --watch >> ""D:\AI-web-app\web-dashboard-v3\dev.err.log"" 2>&1"

REM Start cold. .next\dev survives reboots, and Turbopack's incremental recovery
REM from that stale state is what yields the incomplete route tree above (the
REM 2026-10-29 boot reused a build/ directory that was 9 days old). A cold
REM .next\dev always produces the full route tree. Only the dev-server state is
REM removed - .next\standalone and the production build are left alone.
if exist "D:\AI-web-app\web-dashboard-v3\.next\dev" rmdir /s /q "D:\AI-web-app\web-dashboard-v3\.next\dev"

"C:\Users\lijin\.bun\bin\bunx.exe" next dev -p 3000 > "%OUT%" 2> "%ERR%"
endlocal
