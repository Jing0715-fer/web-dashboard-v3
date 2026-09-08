#!/bin/bash
cd "$(dirname "$0")"
export DATABASE_URL="file:$(pwd)/db/agent.db"
# Schema self-heal: idempotent + additive (new columns like repoUrl/notes
# land automatically after pulling updates). Failure is non-fatal.
bunx prisma db push 2>/dev/null || echo "[start.sh] prisma db push skipped/failed — continuing"
# API key: only pass --apiKey when the caller gave one — otherwise index.ts
# resolves CLI > persisted agent-config.json > fresh random (stable identity).
if [ -n "$2" ]; then
  exec bun index.ts --port ${1:-3100} --apiKey "$2"
else
  exec bun index.ts --port ${1:-3100}
fi
