# Dashboard Agent - Windows Service Installation Script
# Run as Administrator
param(
    [int]$Port = 3100,
    [string]$ApiKey = "",
    [string]$Name = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] This script must be run as Administrator!" -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceName = "DashboardAgent"
$serviceDisplayName = "Dashboard Agent"
$serviceDescription = "Dashboard Agent - Remote device management service for Dashboard application"

# Check if service already exists
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "[INFO] Service '$serviceName' already exists. Removing..." -ForegroundColor Yellow
    sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 2
}

# Generate API key if not provided
if (-not $ApiKey) {
    $ApiKey = -join ((1..64) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Generated API Key (SAVE THIS!):" -ForegroundColor Cyan
    Write-Host "  $ApiKey" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
}

# Save config
$config = @{
    port = $Port
    apiKey = $ApiKey
    name = $Name
} | ConvertTo-Json

Set-Content -Path "$scriptDir\agent-config.json" -Value $config -Encoding UTF8

# Create the service using nssm or sc.exe
# First try nssm, fall back to sc.exe
$nssmPath = "$scriptDir\nssm.exe"
$nodePath = (Get-Command node).Source

if (Test-Path $nssmPath) {
    Write-Host "[INFO] Using NSSM to install service..." -ForegroundColor Green
    & $nssmPath install $serviceName $nodePath "$scriptDir\agent.js"
    & $nssmPath set $serviceName AppParameters "--port $Port --apiKey $ApiKey --name `"$Name`" --config `"$scriptDir\agent-config.json`""
    & $nssmPath set $serviceName AppDirectory $scriptDir
    & $nssmPath set $serviceName DisplayName $serviceDisplayName
    & $nssmPath set $serviceName Description $serviceDescription
    & $nssmPath set $serviceName Start SERVICE_AUTO_START
    & $nssmPath set $serviceName LogStdout "$scriptDir\logs\service-stdout.log"
    & $nssmPath set $serviceName LogStderr "$scriptDir\logs\service-stderr.log"
    & $nssmPath set $serviceName AppEnvironmentExtra "DATABASE_URL=file:$scriptDir\db\agent.db"
} else {
    Write-Host "[INFO] Using sc.exe to install service..." -ForegroundColor Green
    # Create a wrapper script
    $wrapperContent = @"
@echo off
cd /d "$scriptDir"
set DATABASE_URL=file:$scriptDir\db\agent.db
node agent.js --port $Port --apiKey $ApiKey --name "$Name" --config "$scriptDir\agent-config.json"
"@
    Set-Content -Path "$scriptDir\run-agent.bat" -Value $wrapperContent -Encoding ASCII
    
    sc.exe create $serviceName binPath= "$scriptDir\run-agent.bat" start= auto DisplayName= $serviceDisplayName | Out-Null
    sc.exe description $serviceName $serviceDescription | Out-Null
}

# Create logs directory
if (-not (Test-Path "$scriptDir\logs")) {
    New-Item -ItemType Directory -Path "$scriptDir\logs" | Out-Null
}

# Start the service
Write-Host "[INFO] Starting service..." -ForegroundColor Green
Start-Service -Name $serviceName -ErrorAction SilentlyContinue

Start-Sleep -Seconds 3

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -eq 'Running') {
    Write-Host "[SUCCESS] Dashboard Agent service is running!" -ForegroundColor Green
    Write-Host "[INFO] Port: $Port | Name: $Name" -ForegroundColor Cyan
} else {
    Write-Host "[WARNING] Service may not have started. Check with: sc query $serviceName" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Service management commands:" -ForegroundColor Cyan
Write-Host "  Start:   Start-Service -Name $serviceName" 
Write-Host "  Stop:    Stop-Service -Name $serviceName"
Write-Host "  Status:  Get-Service -Name $serviceName"
Write-Host "  Remove:  sc.exe delete $serviceName"
