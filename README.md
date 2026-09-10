# Web Dashboard — Multi-Device Project Control

A production dashboard for managing development projects and their environments
(dev / prod) across multiple machines. Add a project path, and the built-in LLM
layer analyzes it and generates start commands automatically — then start, stop,
restart, and rebuild everything from one place.

Built on top of [web-dashboard-v3](https://github.com/Jing0715-fer/web-dashboard-v3)
with [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) concepts
integrated as the device agent layer.

## Features

- **Project management** — cards or list view, drag-to-reorder, pin, tag, search,
  keyboard shortcuts (⌘K, s/x/e), context menus
- **GitHub integration** — one-click Pull on every project card, live version
  chip (branch @ sha · age, uncommitted-count dot), and an automatic remote
  update check every 10 minutes that badges cards with "Update available"
  (behind / diverged / out-of-sync with the device checkout) and fires one
  aggregated toast notification
- **Environments** — per-project dev/prod environments with start / stop /
  restart / rebuild, live status, HMR awareness, port proxying
- **LLM-assisted onboarding** — new projects are analyzed automatically
  (package.json detection, script generation) via a local OpenAI-compatible
  gateway
- **Multi-device control** — pair remote machines, group projects by device,
  start projects on remote hosts from this dashboard
- **Configurable theming** — light / dark / system mode, 8 accent colors,
  persisted per browser; full-width responsive layout (up to 2304px+)
- **Monitoring** — health score with sparkline, CPU/memory usage, activity feed,
  deployment timeline, log streaming

## Architecture

| Component | Port | Description |
|---|---|---|
| Dashboard (this repo) | 3000 | Next.js App Router UI + REST API + Prisma/SQLite |
| LLM Gateway | 3021 | OpenAI-compatible proxy (`mini-services/llm-gateway`) |
| Device agents | — | `mini-services/agent-linux` / `agent-macos` / `agent-windows` — run on remote machines, register with the dashboard, execute project commands |

Requests to other local services are routed through the gateway with the
`XTransformPort` query parameter (see `Caddyfile`).

## Tech Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS 4 + shadcn/ui (New York) + Framer Motion
- Prisma ORM + SQLite
- dnd-kit for drag-and-drop
- Bun as the runtime / package manager

## Getting Started

```bash
# 1. Install dependencies
bun install

# 2. Configure the database
cp .env.example .env
bun run db:push

# 3. Start the dashboard
bun run dev
```

The dashboard runs on http://localhost:3000.

### Pulling updates (important!)

`bun run dev` auto-runs a `predev` step that self-heals the environment:

1. `bun install` — syncs `node_modules` with newly pulled dependencies
2. `prisma generate` — regenerates the Prisma Client from the current schema
3. `prisma db push` — syncs the SQLite columns

So a plain `git pull` + `bun run dev` is normally all you need after updating.

If you pulled a while ago and dev is already failing, run `bun install` once
(the predev install step is skipped when bun is unavailable/offline), then
`bun run dev` again. The two classic symptoms of a stale environment:

| Error | Missing | Fix |
|---|---|---|
| `Module not found: Can't resolve 'fzstd'` | new dependency in `node_modules` | `bun install` |
| Prisma `Unknown argument 'repoUrl'. Available options are marked with ?` | regenerated Prisma Client | `bun install` (prisma is trusted → auto-generates) or `bunx prisma db push` |
| Remote project edit → `Unauthorized` / `设备「…」的 agent API 密钥不匹配` | device agent key rotation | see "Remote edit returns 401" below |
| Pull → "Server error" with no details, or agent-side `The column 'repoUrl' does not exist` | stale dashboard route code / old device-agent DB schema | see "Pull says Server error" below |
| Pull → "agent too old" · one-way project visibility · "Process exited immediately" | the machine's RUNNING agent process predates its `git pull` | see "One-way project visibility" below |

> Why this happens: `bun install` skips dependency postinstall scripts unless
> the package is listed in `trustedDependencies` — a stale
> `node_modules/.prisma/client` therefore survives `git pull`. Likewise, new
> dependencies added by pulled commits only land on your machine after an
> actual install.

### "Error parsing package.json file" — git conflict markers

```
./package.json:6:1
Error parsing package.json file
> 6 | <<<<<<< Updated upstream
```

This means a `git pull` (with local changes) left **conflict markers** inside
`package.json` — git could not merge your local edit with the incoming one, so
it wrote `<<<<<<<` / `=======` / `>>>>>>>` lines into the file. JSON with those
markers is unparseable, so the dev server cannot even start.

Fix (keep the upstream version — your stale local copy is what conflicted):

```bash
git checkout origin/main -- package.json   # restore the upstream file
git stash list                             # a conflicted "pop" keeps the stash
git stash drop                             # drop it if still listed
bun run dev
```

If other files also show conflict markers, or the repo state looks tangled,
the nuclear option resets everything to the remote state (⚠ discards ALL
uncommitted local changes):

```bash
git reset --hard origin/main
git stash clear
bun run dev
```

> Tip: avoid the situation entirely — commit your local changes (or
> `git stash`) BEFORE pulling, and resolve any conflicts the pull reports
> before starting dev.

### Remote edit returns 401 ("Unauthorized" / agent 密钥不匹配)

Editing a remote project (e.g. setting its GitHub link) failed with a 401?
The device-side agent's API key no longer matches the key this dashboard
stores. Root cause: older TS agents (`mini-services/agent`, `agent-win`)
minted a **fresh random key on every restart** — the heartbeat re-register
refuses unknown keys, so the dashboard keeps the old one and every proxied
call dies with 401. (The repoUrl you typed is still saved in the local
cached row, so it re-appears once the device is fixed.)

Fix — pull this update on the DEVICE machine, restart its agent (the agent
now keeps a stable persisted key), then re-pair once:

1. On the dashboard: Devices → pair/generate a pair code.
2. On the device: re-register the agent with that code (the pair dialog
   shows the exact curl/CLI command).

After re-pairing, keys stay stable across agent restarts — the agent reads
its key back from `agent-config.json` (CLI arg > persisted > fresh random).

### Pull says "Server error" / `The column 'repoUrl' does not exist`

Two different failure signatures, both fixed by the same action — **restart
the stale side**:

| What you saw | Why | Fix |
| --- | --- | --- |
| Toast: "Pull failed — Server error" (no details) | the dashboard route crashed or wasn't loaded — Next answered with an HTML page the UI can't parse. Usually a dev server still running pre-pull code. | `git pull` on the dashboard machine → restart `bun run dev` |
| Prisma dump mentioning `The column \`repoUrl\` does not exist` | the DEVICE agent runs new code but its `agent.db` predates the `repoUrl`/`notes` columns (a `CREATE TABLE IF NOT EXISTS` bootstrap never upgrades an existing file). | pull + restart the agent on that machine — it now self-migrates the DB at boot (`ALTER TABLE … ADD COLUMN`) |

The agent DB migration is automatic since this update: every agent variant
runs idempotent `ALTER TABLE` statements at boot, so old `agent.db` files are
upgraded in place no matter how the agent was started (start script, `bun
index.ts`, service manager). Restarting the agent is enough.

### One-way project visibility / "agent too old" / "Process exited immediately"

These look like three different bugs but usually share ONE root cause: a
machine ran `git pull` but its **running agent process predates the pull**
(`git pull` hot-reloads the dashboard, NOT a spawned agent). Symptom matrix:

| What you saw | Why | Fix |
| --- | --- | --- |
| Pull says "This device agent is too old" | the agent process has no pull endpoint (pre-feature code). The error now reports the agent's running version. | on that machine: `git pull` → **restart the agent** |
| One machine sees the other's projects, not vice versa | the firewalled machine's agent is old and never pushes its project list with the 60s heartbeat (new agents do; the dashboard serves pushed data read-only when direct pull is blocked) | update + restart the agent on the machine whose projects are INVISIBLE |
| Start/restart says "Process exited immediately (exit code N)" | the command died within 2s on that machine — the error now carries the exit code, the command's last output and the full log path. Exit 127/9009 = the command isn't on the AGENT's PATH (service/launchd agents see a minimal PATH — use an absolute path). | read the detail in the toast / the log file it names |

The **Devices panel** now probes every device's `/api/agent/health` (60s
cache) and shows a running version chip plus an amber "Agent outdated" badge
on stale agents — the badge tooltip names the exact machine and the missing
feature, so you don't have to guess which side is old.

### Agent updates (device machines)

After pulling on a device machine, restart its agent — the start scripts now
self-heal the agent DB schema (`prisma db push`, idempotent + additive), and
since the latest update the agent ALSO self-migrates at boot even when
started without a script (`ALTER TABLE` adds any missing columns, e.g.
`repoUrl`/`notes`). The GitHub link and notes configured on a remote dashboard
are persisted by the agent AND mirrored into the co-located home dashboard's
database, so the project's home machine shows the same GitHub link.

### Remote devices

1. Copy `mini-services/agent-linux` (or the macOS/Windows variant) to the
   remote machine.
2. Follow its `QUICKSTART.md` to install and run the agent.
3. Add the device in the dashboard (Devices → Add Device) and start managing
   its projects.

### LLM Gateway

The gateway (`mini-services/llm-gateway`) exposes an OpenAI-compatible API on
port 3021 for project analysis and auto-repair flows. Start it with:

```bash
cd mini-services/llm-gateway && bun run dev
```

## Project Structure

```
src/app/           Dashboard page + REST API routes
src/components/ui  shadcn/ui component set
src/lib            Process manager, device registry, LLM helpers
prisma/            Database schema
mini-services/     Device agents + LLM gateway
db/                SQLite database (runtime, gitignored)
```

## License

MIT
