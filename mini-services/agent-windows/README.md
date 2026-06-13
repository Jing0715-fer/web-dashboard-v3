# Dashboard Agent for Windows

Remote device management service for the Dashboard application. This agent runs on each Windows device and exposes a REST API that the Dashboard can use to manage projects, environments, and processes.

## System Requirements

| Requirement | Minimum |
|---|---|
| **Operating System** | Windows 10 or later |
| **Node.js** | 18.0 or later |
| **Disk Space** | ~50 MB (without projects) |
| **RAM** | 256 MB free |
| **Network** | Port must be accessible from Dashboard |

## Quick Start (3 Steps)

### Method 1: Simple (ZIP Package)

1. **Download** the agent package and extract to a folder (e.g., `C:\Dashboard-Agent\`)
2. **Double-click** `start.bat` — it will:
   - Install dependencies automatically on first run
   - Generate an API key and display it
   - Start the agent
3. **Add the device** in your Dashboard with the displayed IP, port, and API key

### Method 2: EXE Installer

1. **Download** `DashboardAgent-1.2.0-Setup.exe`
2. **Double-click** the installer and follow the wizard
3. **Add the device** in your Dashboard — the installer shows the API key

### Method 3: Windows Service (auto-start on boot)

1. Open **PowerShell as Administrator**
2. Navigate to the agent directory
3. Run:
   ```powershell
   .\install-service.ps1 -Port 3100 -ApiKey "your-api-key" -Name "My-PC"
   ```
4. The service starts automatically and will start on boot

---

## Installation Methods (Detailed)

### 1. Simple Installation (ZIP)

This is the easiest way to get started. No Administrator privileges required.

```bat
:: 1. Extract the ZIP to a folder
:: 2. Navigate to the folder in Explorer
:: 3. Double-click start.bat
```

The batch script will:
- Check for Node.js
- Install npm dependencies on first run
- Generate an API key if not provided
- Start the agent in a terminal window
- Display the API key — **save this!**

To stop: Press `Ctrl+C` or close the terminal window.

### 2. EXE Installer Installation

The EXE installer provides a professional installation experience:

- Installs to `Program Files\Dashboard Agent\` by default
- Creates Start Menu shortcuts
- Optionally creates a Desktop shortcut
- Configures Windows Firewall rules
- Optionally installs as a Windows Service
- Provides an uninstaller in Add/Remove Programs

To build the installer from source:
```bat
build-installer.bat
```

### 3. Windows Service Installation

For production deployments, install the agent as a Windows Service so it:
- Starts automatically when the computer boots
- Runs in the background (no terminal window needed)
- Restarts automatically if it crashes (when using NSSM)

```powershell
# Install (run as Administrator)
.\install-service.ps1 -Port 3100 -Name "My-PC"

# Uninstall (run as Administrator)
.\uninstall-service.ps1
```

**Service Management:**
```powershell
Start-Service -Name DashboardAgent      # Start
Stop-Service -Name DashboardAgent       # Stop
Get-Service -Name DashboardAgent        # Check status
sc.exe delete DashboardAgent            # Remove
```

### 4. Interactive Setup Wizard

For first-time users, the setup wizard guides you through the entire process:

```bat
node setup.js
```

The wizard will:
1. Check system requirements
2. Ask for configuration (port, name, API key)
3. Install npm dependencies
4. Set up the database (Prisma generate + db push)
5. Save configuration to `agent-config.json`
6. Optionally install as Windows Service
7. Test the connection
8. Show next steps

---

## Configuration

### Command-Line Arguments

| Flag | Default | Description |
|---|---|---|
| `--port` | `3100` | HTTP server port |
| `--apiKey` | auto-generated | Bearer token for API authentication |
| `--name` | Computer name | Agent display name |
| `--host` | `0.0.0.0` | Bind address (Linux/macOS only) |
| `--config` | — | Path to JSON config file |
| `--install-service` | — | Install as Windows Service (Windows only) |
| `--uninstall-service` | — | Uninstall Windows Service (Windows only) |

### Configuration File (`agent-config.json`)

```json
{
  "port": 3100,
  "apiKey": "your-secret-api-key",
  "name": "My-Windows-PC",
  "dbPath": "C:\\Dashboard-Agent\\db\\agent.db"
}
```

CLI arguments take precedence over the config file.

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQLite database path (e.g., `file:C:\Dashboard-Agent\db\agent.db`) |

---

## API Reference

All API endpoints require Bearer token authentication (except health check).

### Health Check (No Auth)

```
GET /api/agent/health
```

Response:
```json
{
  "status": "ok",
  "name": "My-PC",
  "uptime": 3600,
  "version": "1.2.0",
  "platform": "win32",
  "arch": "x64",
  "pid": 12345
}
```

### Projects

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/agent/projects` | List all projects with environments |
| `POST` | `/api/agent/projects` | Create a new project |
| `GET` | `/api/agent/projects/:id` | Get project details |
| `PUT` | `/api/agent/projects/:id` | Update project |
| `DELETE` | `/api/agent/projects/:id` | Delete project (stops all environments) |

### Environments

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/agent/projects/:id/environments` | Add environment to project |
| `PUT` | `/api/agent/projects/:id/environments/:envId` | Update environment |
| `DELETE` | `/api/agent/projects/:id/environments/:envId` | Delete environment |

### Process Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/agent/projects/:id/environments/:envId/start` | Start environment process |
| `POST` | `/api/agent/projects/:id/environments/:envId/stop` | Stop environment process |
| `POST` | `/api/agent/projects/:id/environments/:envId/restart` | Restart environment process |
| `POST` | `/api/agent/projects/:id/environments/:envId/rebuild` | Stop and rebuild environment |

### Monitoring

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/agent/projects/:id/environments/:envId/logs` | Get environment logs |
| `GET` | `/api/agent/projects/:id/logs` | Get project-level logs |
| `GET` | `/api/agent/projects/:id/activity` | Get project activity events |

---

## API Key Management

### Generating a New Key

```bat
:: Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

:: Using start.bat (auto-generates if not provided)
start.bat

:: Using PowerShell
-join ((1..64) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

### Changing the API Key

1. Stop the agent
2. Edit `agent-config.json` and update the `apiKey` field
3. Start the agent with `--config agent-config.json`
4. Update the API key in your Dashboard device settings

### Security Notes

- The API key is displayed only once during setup — **save it securely**
- All API requests (except health check) require the `Authorization: Bearer <key>` header
- The key is stored in `agent-config.json` — restrict file access to authorized users
- If the key is compromised, generate a new one and update all clients

---

## Firewall Setup

The agent listens on a TCP port (default: 3100). You need to open this port in Windows Firewall for the Dashboard to connect.

### Automatic (during installation)

The EXE installer automatically adds a firewall rule. If you used the ZIP installation, run:

```bat
:: Run as Administrator
netsh advfirewall firewall add rule name="Dashboard Agent" dir=in action=allow protocol=TCP localport=3100
```

### Verify the Rule

```bat
netsh advfirewall firewall show rule name="Dashboard Agent"
```

### Remove the Rule

```bat
netsh advfirewall firewall delete rule name="Dashboard Agent"
```

### For Corporate Networks

If you're behind a corporate firewall, you may need to:
1. Contact your IT department to open the port
2. Or use a reverse proxy (e.g., nginx) to route traffic through an allowed port (80/443)

---

## Troubleshooting

### "Node.js is not installed"

**Solution:** Download and install Node.js 18+ from https://nodejs.org

After installation, restart your terminal and verify:
```bat
node --version
```

### Port Already in Use

**Error:** `[Agent] EADDRINUSE: address already in use :::3100`

**Solution:** Change the port or find what's using it:
```bat
:: Find process using port 3100
netstat -ano | findstr :3100 | findstr LISTENING

:: Kill the process (replace PID)
taskkill /PID 12345 /T /F

:: Or use a different port
start.bat --port 3200
```

### Cannot Connect from Dashboard

1. **Check the agent is running:**
   ```bat
   curl http://127.0.0.1:3100/api/agent/health
   ```

2. **Check firewall:**
   ```bat
   netsh advfirewall firewall show rule name="Dashboard Agent"
   ```

3. **Check the IP address:**
   ```bat
   ipconfig
   ```
   Use the IP shown for your network adapter.

4. **Test from another device:**
   ```bat
   curl http://192.168.1.100:3100/api/agent/health
   ```

### Service Won't Start

1. Check logs in `logs\service-stdout.log` and `logs\service-stderr.log`
2. Verify Node.js is in the system PATH (not just user PATH)
3. Try running the agent manually first:
   ```bat
   node agent.js --port 3100 --apiKey test
   ```
4. Reinstall the service:
   ```powershell
   .\uninstall-service.ps1
   .\install-service.ps1 -Port 3100 -ApiKey "your-key"
   ```

### Prisma Errors

If you see Prisma-related errors:
```bat
:: Regenerate the client
npx prisma generate

:: Reset the database (WARNING: deletes all data)
del db\agent.db
npx prisma db push
```

### "Command not allowed"

The agent has a command whitelist for security. Only these commands are allowed:
- Package managers: `npm`, `npx`, `yarn`, `pnpm`, `bun`
- Runtimes: `node`, `python`, `python3`, `go`, `java`, `ruby`
- Build tools: `make`, `gradle`, `cargo`, `dotnet`
- Docker: `docker`, `docker-compose`
- Windows: `cmd`, `powershell`, `pwsh`, `npm.cmd`, `npx.cmd`

If you need to run a command not in the whitelist, you must edit `agent.js` and add it to the `allowed` array in the `isCommandSafe` function.

---

## Building from Source

### Prerequisites

- Node.js 18+
- npm
- Inno Setup 6 (for EXE installer only)

### Build Steps

```bat
:: 1. Clone the repository
git clone <repo-url>
cd agent-windows

:: 2. Install dependencies
npm install

:: 3. Generate Prisma client
npx prisma generate

:: 4. Set up the database
set DATABASE_URL=file:%cd%\db\agent.db
npx prisma db push

:: 5. Run the agent
node agent.js --port 3100 --apiKey test-key

:: 6. Build EXE installer (optional)
build-installer.bat
```

### Build a Standalone Executable (Advanced)

Using `pkg` to create a standalone .exe that doesn't require Node.js:

```bat
:: Install pkg globally
npm install -g pkg

:: Build for Windows x64
npm run build:exe

:: Output: dist\dashboard-agent.exe
```

Note: The standalone exe still requires the `prisma/` folder and `db/` directory alongside it.

---

## File Structure

```
agent-windows/
├── agent.js               # Main agent server (Node.js)
├── package.json            # Node.js package definition
├── setup.js                # Interactive setup wizard
├── start.bat               # Quick-start batch script
├── install-service.ps1     # Windows Service installer
├── uninstall-service.ps1   # Windows Service uninstaller
├── build-installer.bat     # Build EXE installer script
├── agent-installer.iss     # Inno Setup installer definition
├── README.md               # This file
├── .env.example            # Environment variable template
├── prisma/
│   └── schema.prisma       # Database schema
├── db/                     # SQLite database (created at runtime)
└── logs/                   # Service logs (created at runtime)
```

---

## License

Dashboard Agent - Remote device management service
