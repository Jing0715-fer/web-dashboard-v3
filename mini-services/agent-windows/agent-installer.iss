; ==============================================================================
; Dashboard Agent — Inno Setup Installer Script
; ==============================================================================
; This script creates a professional Windows installer (.exe) for the
; Dashboard Agent using Inno Setup (https://jrsoftware.org/isinfo.php).
;
; To build the installer:
;   1. Install Inno Setup from https://jrsoftware.org/isinfo.php
;   2. Run build-installer.bat (or compile this file in Inno Setup IDE)
;
; ==============================================================================

#define AppName "Dashboard Agent"
#define AppVersion "1.2.0"
#define AppPublisher "Dashboard"
#define AppURL "https://github.com/dashboard/agent"
#define AppExeName "agent.js"
#define AppServiceName "DashboardAgent"

[Setup]
; Application info
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}

; Installation directory
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}

; Output
OutputDir=dist
OutputBaseFilename=DashboardAgent-{#AppVersion}-Setup
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

; Privileges
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

; Uninstall
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\agent.js

; License
; Uncomment the line below and provide a license file
; LicenseFile=LICENSE

; Architecture
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Windows version
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; ==============================================================================
; Custom Pages — Configuration during installation
; ==============================================================================

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  PortEdit: TEdit;
  ApiKeyEdit: TEdit;
  NameEdit: TEdit;
  InstallServiceCheck: TCheckBox;

procedure InitializeWizard;
var
  ConfigPageID: Integer;
  GeneratedKey: string;
begin
  { Create custom configuration page }
  ConfigPage := CreateInputQueryPage(wpInfoAfter,
    'Agent Configuration',
    'Configure the Dashboard Agent',
    'Please enter the configuration for the Dashboard Agent. ' +
    'The API Key is used to secure communication with the Dashboard.');

  ConfigPage.Add('Port:', False, '3100');
  
  { Generate a random API key }
  GeneratedKey := '';
  ConfigPage.Add('API Key (leave empty to auto-generate):', False, '');
  
  ConfigPage.Add('Agent Name:', False, GetComputerNameString());
end;

function GetComputerNameString: string;
var
  ComputerName: string;
  BufSize: DWORD;
begin
  BufSize := 256;
  SetLength(ComputerName, BufSize);
  if GetComputerName(ComputerName, BufSize) then
    Result := Copy(ComputerName, 1, BufSize)
  else
    Result := 'MyDevice';
end;

; ==============================================================================
; Files to include in the installer
; ==============================================================================

[Files]
; Main agent file
Source: "agent.js"; DestDir: "{app}"; Flags: ignoreversion

; Package and config files
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: ".env.example"; DestDir: "{app}"; Flags: ignoreversion

; Prisma schema and engine
Source: "prisma\*"; DestDir: "{app}\prisma"; Flags: ignoreversion recursesubdirs createallsubdirs

; Windows scripts
Source: "start.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

; Setup wizard
Source: "setup.js"; DestDir: "{app}"; Flags: ignoreversion

; Documentation
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion

; Note: node_modules will be installed during post-install step
; Note: db/ directory will be created during post-install step

; ==============================================================================
; Directories to create
; ==============================================================================

[Dirs]
Name: "{app}\db"; Permissions: users-full
Name: "{app}\logs"; Permissions: users-full

; ==============================================================================
; Shortcuts
; ==============================================================================

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"
Name: "startmenuicon"; Description: "Create a &Start Menu shortcut"; GroupDescription: "Additional icons:"
Name: "installservice"; Description: "Install as Windows &Service (starts on boot)"; GroupDescription: "Service Installation:"; Flags: unchecked

[Icons]
Name: "{group}\Dashboard Agent"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Tasks: startmenuicon
Name: "{group}\Uninstall Dashboard Agent"; Filename: "{uninstallexe}"; Tasks: startmenuicon
Name: "{autodesktop}\Dashboard Agent"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; Tasks: desktopicon

; ==============================================================================
; Registry entries
; ==============================================================================

[Registry]
; Add to PATH (optional, for command-line access)
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
    ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; \
    Flags: preservestringtype dontcreatekey

; ==============================================================================
; Post-install steps
; ==============================================================================

[Run]
; Run npm install
Filename: "cmd.exe"; Parameters: "/c ""cd /d ""{app}"" && npm install --production"""; \
    Description: "Installing dependencies..."; \
    StatusMsg: "Installing npm dependencies (this may take a few minutes)..."; \
    Flags: runhidden waituntilterminated

; Run prisma generate
Filename: "cmd.exe"; Parameters: "/c ""cd /d ""{app}"" && npx prisma generate"""; \
    Description: "Generating Prisma client..."; \
    StatusMsg: "Generating Prisma client..."; \
    Flags: runhidden waituntilterminated

; Run prisma db push
Filename: "cmd.exe"; Parameters: "/c ""cd /d ""{app}"" && set DATABASE_URL=file:{app}\db\agent.db && npx prisma db push"""; \
    Description: "Setting up database..."; \
    StatusMsg: "Setting up database..."; \
    Flags: runhidden waituntilterminated

; Save configuration
Filename: "cmd.exe"; Parameters: "/c ""cd /d ""{app}"" && node -e ""const fs=require('fs');const c={port:3100,apiKey:'',name:require('os').hostname(),createdAt:new Date().toISOString()};fs.writeFileSync('agent-config.json',JSON.stringify(c,null,2))""""; \
    StatusMsg: "Saving configuration..."; \
    Flags: runhidden waituntilterminated

; Open firewall port
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""Dashboard Agent"" dir=in action=allow protocol=TCP localport=3100"; \
    StatusMsg: "Configuring Windows Firewall..."; \
    Flags: runhidden waituntilterminated

; Optional: Install as Windows Service
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-service.ps1"""; \
    Description: "Install as Windows Service"; \
    StatusMsg: "Installing Windows Service..."; \
    Flags: runhidden waituntilterminated postinstall skipifsilent; \
    Tasks: installservice

; Launch agent after install
Filename: "{app}\start.bat"; \
    Description: "&Launch Dashboard Agent"; \
    WorkingDir: "{app}"; \
    Flags: nowait postinstall skipifsilent

; ==============================================================================
; Pre-uninstall steps
; ==============================================================================

[UninstallRun]
; Stop and remove Windows Service if installed
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"""; \
    Flags: runhidden waituntilterminated

; Remove firewall rule
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Dashboard Agent"""; \
    Flags: runhidden waituntilterminated

; ==============================================================================
; Uninstall cleanup
; ==============================================================================

[UninstallDelete]
Type: filesandordirs; Name: "{app}\db"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\dist"
Type: files; Name: "{app}\agent-config.json"
Type: files; Name: "{app}\agent.pid"
Type: files; Name: "{app}\.env"

; ==============================================================================
; Code section for custom logic
; ==============================================================================

[Code]
function InitializeSetup: Boolean;
begin
  Result := True;
  
  { Check for Node.js }
  if not FileExists(ExpandConstant('{cmd}')) then
  begin
    MsgBox('This application requires Node.js 18+ to be installed.' + #13#10 +
           'Please download and install Node.js from https://nodejs.org' + #13#10 +
           'Then run this installer again.', mbError, MB_OK);
    Result := False;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoGroupInfo, MemoTasksInfo: String): String;
var
  S: String;
begin
  S := '';
  S := S + MemoDirInfo + NewLine + NewLine;
  S := S + MemoGroupInfo + NewLine + NewLine;
  S := S + 'Configuration:' + NewLine;
  S := S + Space + 'Port: ' + ConfigPage.Values[0] + NewLine;
  S := S + Space + 'API Key: ' + IfThen(ConfigPage.Values[1] = '', '(auto-generated)', '********') + NewLine;
  S := S + Space + 'Name: ' + ConfigPage.Values[2] + NewLine + NewLine;
  S := S + MemoTasksInfo;
  Result := S;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigJson: string;
  Port: string;
  ApiKey: string;
  AgentName: string;
begin
  if CurStep = ssPostInstall then
  begin
    { Read configuration from custom page }
    Port := ConfigPage.Values[0];
    ApiKey := ConfigPage.Values[1];
    AgentName := ConfigPage.Values[2];
    
    { Generate API key if empty }
    if ApiKey = '' then
    begin
      { Simple random key generation using PowerShell }
      Exec('powershell.exe', '-Command "$key = -join ((1..64) | ForEach-Object { ''{0:x2}'' -f (Get-Random -Maximum 256) }); $config = @{port=' + Port + ';apiKey=$key;name=''' + AgentName + '''} | ConvertTo-Json; Set-Content -Path ''' + ExpandConstant('{app}\agent-config.json') + ''' -Value $config"', 
        '', SW_HIDE, ewWaitUntilTerminated, nil);
    end
    else
    begin
      { Save config with provided API key }
      ConfigJson := '{' + #13#10 +
        '  "port": ' + Port + ',' + #13#10 +
        '  "apiKey": "' + ApiKey + '",' + #13#10 +
        '  "name": "' + AgentName + '",' + #13#10 +
        '  "createdAt": "' + GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '"' + #13#10 +
        '}';
      SaveStringToFile(ExpandConstant('{app}\agent-config.json'), ConfigJson, False);
    end;
    
    { Save .env file }
    SaveStringToFile(ExpandConstant('{app}\.env'), 
      'DATABASE_URL=file:' + ExpandConstant('{app}\db\agent.db') + #13#10, False);
  end;
end;
