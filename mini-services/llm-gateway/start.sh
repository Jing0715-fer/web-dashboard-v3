#!/usr/bin/env bash
# llm-gateway daemon launcher — run by launchd on boot.
# Usage: ./start.sh
# Re-reads mini-services/llm-gateway/config.json on every request (no restart needed).
set -euo pipefail
cd "$(dirname "$0")"
exec /Users/lijing/.local/bin/bun run index.ts