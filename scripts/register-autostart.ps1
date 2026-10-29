#!/usr/bin/env pwsh
# ============================================
#  Register v3 Auto-Start (Permanent Fix)
# ============================================
#
#  Registers a Task Scheduler OnLogon task that calls watchdog.ps1
#  directly. The watchdog itself runs forever as the task process, so
#  Task Scheduler's RestartCount actually works if it dies.
#
#  Also writes a backup HKCU\...\Run registry key that fires the same
#  watchdog, so even if Task Scheduler somehow fails, the user logging
#  in still gets the watchdog started.

$ErrorActionPreference = 'Stop'

$ROOT     = 'D:\AI-web-app\web-dashboard-v3'
$WD_FILE  = "$ROOT\watchdog.ps1"
$WD_LOG   = "$ROOT\watchdog.stdout.log"

# ---- 1. Delete old broken tasks ----
$oldTasks = @('WebDashboardV3-DevWatch', 'WebDashboardV3-AgentWatch')
foreach ($t in $oldTasks) {
    $existing = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "Deleted old task: $t"
    }
}

# ---- 2. Register new watchdog task ----
$action = New-ScheduledTaskAction `
    -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WD_FILE`"" `
    -WorkingDirectory $ROOT

$trigger = New-ScheduledTaskTrigger -AtLogOn `
    -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT15S'  # 15s after login — fast

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 0) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive

Register-ScheduledTask `
    -TaskName 'WebDashboardV3-Watchdog' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Web Dashboard v3 dev-server watchdog (Next.js port 3000). Auto-starts on user login. Self-heals via Task Scheduler RestartCount.' `
    -Force | Out-Null

Write-Host 'Registered: WebDashboardV3-Watchdog'

# ---- 3. Backup: HKCU\...\Run registry key ----
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$regName = 'WebDashboardV3-Watchdog'
$regCmd  = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WD_FILE`""

try {
    if (Test-Path $regPath) {
        Set-ItemProperty -Path $regPath -Name $regName -Value $regCmd -Force
        Write-Host "Set HKCU Run backup: $regName"
    } else {
        Write-Host "WARN: $regPath not found, skipping registry backup"
    }
} catch {
    Write-Host "WARN: registry write failed: $($_.Exception.Message)"
}

Write-Host 'Done.'
