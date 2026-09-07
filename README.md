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

> Why this happens: `bun install` skips dependency postinstall scripts unless
> the package is listed in `trustedDependencies` — a stale
> `node_modules/.prisma/client` therefore survives `git pull`. Likewise, new
> dependencies added by pulled commits only land on your machine after an
> actual install.

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
