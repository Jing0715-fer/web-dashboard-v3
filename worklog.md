# Web Dashboard Multi-Device Interconnection - Worklog

## Project Status
- Dashboard cloned from GitHub and running on Next.js 16 (Turbopack)
- Multi-device interconnection features implemented across all 4 phases
- Dev server running on port 3000, Agent service on port 3100

## Completed Work

### Phase 1: Schema + Backend Core
- **Schema**: Added `Device` model and `deviceId` field to `Project` model in Prisma schema
  - `@@unique([deviceId, path])` for multi-device path uniqueness
  - `onDelete: SetNull` for safe device deletion
- **Device CRUD APIs**: Created 3 route files:
  - `GET/POST /api/devices` - List/Create devices
  - `GET/PUT/DELETE /api/devices/[id]` - CRUD single device
  - `GET /api/devices/[id]/health` - Health check
- **Libraries**: Created 3 lib files:
  - `src/lib/device-registry.ts` - In-memory cache + periodic health checker
  - `src/lib/remote-agent.ts` - HTTP client for proxying to agents
  - `src/lib/route-decision.ts` - Route decision helper (isRemoteProject, proxyProjectAction)
- **Project aggregation**: Modified `GET /api/projects` to aggregate local + remote projects
- **Proxy routes**: All environment action routes (start/stop/restart/logs/activity) now support remote projects via proxy

### Phase 2: Remote Agent
- Created `mini-services/agent/` as standalone bun project
- Agent exposes REST API on port 3100:
  - `GET /api/agent/health` (no auth)
  - `GET /api/agent/projects` (auth required)
  - `POST /api/agent/projects/:id/environments/:envId/start|stop|restart`
  - `GET /api/agent/projects/:id/environments/:envId/logs`
  - `PUT /api/agent/projects/:id/environments/:envId` (env update)
- Agent uses its own SQLite database
- API key authentication for all endpoints except health

### Phase 3: Frontend UI
- **Device Selector**: Dropdown in header showing "All Devices", "💻 This Machine", and registered devices
- **Remote Badge**: Project cards show device badge for remote projects (🟢/🔴 DeviceName)
- **Device Management Panel**: Sheet accessible from footer "Devices" button
  - List devices with status, IP:port, project count, last seen
  - Add/Edit/Delete devices
  - Health check button
- **DetailSheet**: Shows "💻 This Machine" for local projects, device info for remote projects
- **Device Grouping**: When "All Devices" selected, projects grouped by device

### Phase 4: Testing & Verification
- Browser testing with agent-browser confirmed all UI elements work
- Device selector dropdown renders correctly
- Device management panel opens and shows device list
- Add device form works
- Project creation and detail sheet work
- All API endpoints return 200 (projects, devices, notifications, health)
- Lint passes with 0 errors (only 3 unused eslint-disable warnings)

## Known Issues
1. **Agent process stability**: The agent mini-service dies after a few seconds in the sandbox environment (background process limitation). Works correctly when actively running.
2. **Device health check**: Shows "offline" when agent is not running (expected behavior)
3. **nativeButton warning**: React doesn't recognize the `nativeButton` prop from @base-ui/react - cosmetic only

## Architecture Decisions
1. Remote projects are fetched from agents at API call time (not stored in local DB)
2. Device IDs in the project list come from the remote agent's database
3. All environment actions transparently proxy to the remote agent when project has deviceId
4. Device API key uses `@unique` constraint for security
5. Schema uses `@@unique([deviceId, path])` instead of `@unique` on path alone for multi-device support

## File Changes Summary

### New Files (10)
- `src/app/api/devices/route.ts`
- `src/app/api/devices/[id]/route.ts`
- `src/app/api/devices/[id]/health/route.ts`
- `src/lib/device-registry.ts`
- `src/lib/remote-agent.ts`
- `src/lib/route-decision.ts`
- `mini-services/agent/index.ts`
- `mini-services/agent/package.json`
- `mini-services/agent/prisma/schema.prisma`
- `mini-services/agent/.env`

### Modified Files (9)
- `prisma/schema.prisma` - Added Device model + Project.deviceId
- `src/app/api/projects/route.ts` - Aggregation logic
- `src/app/api/projects/[id]/route.ts` - Remote project support
- `src/app/api/projects/[id]/environments/[envId]/start/route.ts` - Route decision
- `src/app/api/projects/[id]/environments/[envId]/stop/route.ts` - Route decision
- `src/app/api/projects/[id]/environments/[envId]/restart/route.ts` - Route decision
- `src/app/api/projects/[id]/environments/[envId]/logs/route.ts` - Route decision
- `src/app/api/projects/[id]/environments/[envId]/route.ts` - Route decision
- `src/app/api/projects/[id]/activity/route.ts` - Route decision
- `src/app/api/projects/[id]/logs/route.ts` - Route decision
- `src/app/page.tsx` - All frontend UI changes
- `next.config.ts` - Turbopack config fix
