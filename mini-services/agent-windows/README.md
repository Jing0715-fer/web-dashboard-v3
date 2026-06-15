# Dashboard Agent — Windows

## Quick Start
```bash
./start.sh
```

## Manual Start
```bash
npm install
node agent.js
```

## Install as Service (Windows Task Scheduler)
```powershell
node agent.js   # Then call /api/agent/start-service
```

## Environment Variables
- `PORT` — HTTP port (default: 3100)
- `API_KEY` — Auth key (auto-generated if not set)
- `DB_PATH` — SQLite database path

## API Endpoints
- `GET /api/agent/health` — Health check + system info
- `GET /api/agent/info` — Agent info + API key
- `POST /api/agent/start-service` — Install as Windows Scheduled Task
- `POST /api/agent/stop-service` — Remove Scheduled Task
