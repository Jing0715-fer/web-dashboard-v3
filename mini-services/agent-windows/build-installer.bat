@echo off
title Build Dashboard Agent Installer
cd /d "%~dp0"

echo ============================================
echo   Dashboard Agent - Build Windows Installer
echo ============================================
echo.

:: Check for Inno Setup
set ISCC_PATH=""

:: Check common install locations
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    set ISCC_PATH="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
    set ISCC_PATH="C:\Program Files\Inno Setup 6\ISCC.exe"
)
if exist "C:\Program Files (x86)\Inno Setup 5\ISCC.exe" (
    set ISCC_PATH="C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
)

:: Allow override via environment variable
if defined INNO_SETUP_PATH (
    set ISCC_PATH="%INNO_SETUP_PATH%"
)

if %ISCC_PATH%=="" (
    echo [ERROR] Inno Setup is not installed.
    echo.
    echo Please install Inno Setup 6 from https://jrsoftware.org/isinfo.php
    echo Or set the INNO_SETUP_PATH environment variable to the ISCC.exe path.
    echo.
    pause
    exit /b 1
)

echo [INFO] Found Inno Setup at: %ISCC_PATH%
echo.

:: Step 1: Install dependencies
echo [Step 1] Installing npm dependencies...
call npm install --production
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to install npm dependencies.
    pause
    exit /b 1
)
echo [OK] Dependencies installed.
echo.

:: Step 2: Generate Prisma client
echo [Step 2] Generating Prisma client...
call npx prisma generate
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to generate Prisma client.
    pause
    exit /b 1
)
echo [OK] Prisma client generated.
echo.

:: Step 3: Create output directory
echo [Step 3] Creating output directory...
if not exist "dist" mkdir "dist"
echo [OK] Output directory ready.
echo.

:: Step 4: Build installer
echo [Step 4] Compiling Inno Setup script...
%ISCC_PATH% agent-installer.iss
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to compile installer.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build Complete!
echo ============================================
echo.
echo   Installer: dist\DashboardAgent-1.2.0-Setup.exe
echo.
echo   You can distribute this .exe file to users.
echo   They just need to double-click it to install
echo   the Dashboard Agent on their Windows device.
echo.
pause
