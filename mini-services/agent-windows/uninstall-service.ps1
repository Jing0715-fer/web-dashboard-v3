# Dashboard Agent - Windows Service Uninstallation Script
# Run as Administrator

$ErrorActionPreference = "Stop"
$serviceName = "DashboardAgent"

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] This script must be run as Administrator!" -ForegroundColor Red
    exit 1
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "[INFO] Service '$serviceName' is not installed." -ForegroundColor Yellow
    exit 0
}

Write-Host "[INFO] Stopping service..." -ForegroundColor Yellow
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Write-Host "[INFO] Removing service..." -ForegroundColor Yellow
sc.exe delete $serviceName | Out-Null
Start-Sleep -Seconds 2

Write-Host "[SUCCESS] Dashboard Agent service has been removed." -ForegroundColor Green
