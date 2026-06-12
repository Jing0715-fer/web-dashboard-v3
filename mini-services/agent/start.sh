#!/bin/bash
cd "$(dirname "$0")"
export DATABASE_URL="file:$(pwd)/db/agent.db"
exec bun index.ts --port ${1:-3100} --apiKey ${2:-test-api-key-12345}
