#!/usr/bin/env pwsh
# ============================================
#  Web Dashboard v3 - Permanent Watchdog v2
# ============================================
#
#  Runs forever as a single process. Watches port 3000 and restarts
#  the Next.js dev server if it dies.
#
#  Spawns Next.js via Start-Process -PassThru -Wait:$false.
#  The new process is a direct child of this powershell — but if this
#  powershell dies, the child stays alive (Windows process model,
#  no automatic reaping on parent exit).
#
#  This is the task process itself, so Task Scheduler's RestartCount
#  will revive it if it ever dies.

$ErrorActionPreference = 'SilentlyContinue'

$ROOT       = 'D:\AI-web-app\web-dashboard-v3'
$DEV_OUT    = "$ROOT\dev.out.log"
$DEV_ERR    = "$ROOT\dev.err.log"
$WATCH_LOG  = "$ROOT\watchdog.log"
$PORT       = 3001
$NPX        = 'C:\Users\lijin\AppData\Local\pi-node\current\npx.cmd'
$INTERVAL   = 10

function Log([string]$msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $WATCH_LOG -Value "[$ts] $msg"
}

function IsListening([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

function Start-NextDev {
    # Truncate dev logs so each restart cycle is self-contained
    '' | Set-Content -Path $DEV_OUT -Encoding UTF8
    '' | Set-Content -Path $DEV_ERR -Encoding UTF8

    # We cannot call Start-Process -FilePath npx.cmd -ArgumentList @('next','dev',...)
    # directly — PowerShell 5.1's array-arg parser rejects any token containing
    # "tmp" (Chinese-locale error "关键字:tmp"). The fix is to invoke the
    # launcher .cmd via cmd.exe with a single string argument. cmd.exe doesn't
    # care about "tmp".
    $launcher = "$ROOT\scripts\launch-next.cmd"
    $cmdArgs  = "/c `"$launcher`""

    $p = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList $cmdArgs `
        -WorkingDirectory $ROOT `
        -WindowStyle Hidden `
        -PassThru `
        -Wait:$false

    if ($p -and $p.Id -gt 0) {
        return $p.Id
    }
    # Fallback: parse the actual next-dev process from WMI
    Start-Sleep -Milliseconds 500
    $next = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*next*dev*' } |
        Select-Object -First 1
    if ($next) { return [int]$next.ProcessId }
    return 0
}

# --- main loop ---
Log "watchdog online (PID=$PID, parent=$($myInvocation.MyCommand.Path))"

while ($true) {
    if (-not (IsListening $PORT)) {
        Log "port $PORT NOT listening — relaunching Next.js"
        $newPid = Start-NextDev
        Log "Next.js launched (PID=$newPid), waiting 8s for port bind"
        Start-Sleep -Seconds 8
    }
    Start-Sleep -Seconds $INTERVAL
}
