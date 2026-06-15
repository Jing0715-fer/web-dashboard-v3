#!/bin/bash
set -e
cd "$(dirname "$0")"

# =============================================================
#  Fixed API Key - CHANGE THIS to your own secret.
#  This Key is used every time you start the agent. The first
#  launch also writes it into agent-config.json so other tools
#  (Dashboard backend, scripts) can read it from there.
# =============================================================
DEFAULT_API_KEY="my-secret-key-2024"
# =============================================================

echo
echo "============================================"
echo "  Dashboard Agent - One-Click Start"
echo "============================================"
echo

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not installed. Please install Node.js 18+ from https://nodejs.org"
    exit 1
fi
NODE_VER=$(node --version)
echo "[OK] Node.js $NODE_VER detected"
NPM_VER=$(npm --version 2>/dev/null || echo "unknown")
echo "[OK] npm $NPM_VER detected"
echo

# npm mirror
NPM_REG=$(npm config get registry 2>/dev/null || true)
if ! echo "$NPM_REG" | grep -qi "npmmirror"; then
    echo "[INFO] Setting npm mirror to npmmirror for faster install"
    npm config set registry https://registry.npmmirror.com
fi
echo

# Install deps
if [ ! -d "node_modules/@prisma/client" ]; then
    echo "[1/4] Installing dependencies"
    npm install --production
    echo "[OK] Dependencies installed"
else
    echo "[1/4] Dependencies present"
fi
echo

# Prisma generate
if [ ! -f "node_modules/.prisma/client/default.js" ]; then
    echo "[2/4] Generating Prisma client"
    mkdir -p db
    DB_FULLPATH="$(pwd)/db/agent.db"
    export DATABASE_URL="file:$DB_FULLPATH"
    npx --yes prisma generate
    echo "[OK] Prisma generated"
else
    echo "[2/4] Prisma already generated"
fi
echo

# Initialize database
if [ ! -f "db/agent.db" ]; then
    echo "[3/4] Initializing database"
    mkdir -p db
    DB_FULLPATH="$(pwd)/db/agent.db"
    export DATABASE_URL="file:$DB_FULLPATH"
    if npx --yes prisma db push --skip-generate; then
        echo "[OK] Database initialized"
    else
        echo "[WARN] prisma db push failed"
    fi
else
    echo "[3/4] Database exists"
fi
echo

# Stop old instance
if [ -f "agent.pid" ]; then
    OLD_PID=$(cat agent.pid 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[INFO] Stopping PID $OLD_PID"
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f agent.pid
fi

# Pick port
FREE_PORT=3100
for try_port in $(seq 3100 3109); do
    if ! lsof -i ":$try_port" >/dev/null 2>&1 && ! nc -z localhost "$try_port" 2>/dev/null; then
        FREE_PORT=$try_port
        break
    fi
done
AGENT_PORT=$FREE_PORT
AGENT_NAME=$(hostname 2>/dev/null || uname -n)

# Resolve API Key
if [ -f "agent-config.json" ]; then
    AGENT_KEY=$(node -e "try{const c=require('./agent-config.json');process.stdout.write(c.apiKey||'')}catch(e){}" 2>/dev/null || true)
    if [ -z "$AGENT_KEY" ]; then
        AGENT_KEY="$DEFAULT_API_KEY"
    fi
    echo "[INFO] API Key loaded from agent-config.json"
else
    AGENT_KEY="$DEFAULT_API_KEY"
    echo "[INFO] First run - saving default API Key to agent-config.json"
    cat > agent-config.json <<EOF
{
  "port": 3100,
  "apiKey": "$DEFAULT_API_KEY",
  "name": "$AGENT_NAME",
  "dbPath": "db/agent.db",
  "createdAt": "$(date '+%Y-%m-%d %H:%M:%S')",
  "version": "1.2.0"
}
EOF
fi

echo
echo "============================================"
echo "  Agent starting on port $AGENT_PORT"
echo "  Name:   $AGENT_NAME"
echo "  API Key: $AGENT_KEY"
echo "============================================"
echo
echo "Health (no auth): http://localhost:$AGENT_PORT/api/agent/health"
echo "Authorized calls need header:  Authorization: Bearer ***"
echo
echo "[INFO] Key is FIXED. To change it, edit DEFAULT_API_KEY in start.sh"
echo "[INFO] Or delete agent-config.json to re-trigger the save with a new default."
echo "[INFO] Ctrl+C to stop."
echo

cat > .agent-session.env <<EOF
AGENT_PORT=$AGENT_PORT
AGENT_NAME=$AGENT_NAME
AGENT_KEY=$AGENT_KEY
EOF

DB_FULLPATH="$(pwd)/db/agent.db"
export DATABASE_URL="file:$DB_FULLPATH"
node agent.js --port "$AGENT_PORT" --apiKey "$AGENT_KEY" --name "$AGENT_NAME"

rm -f agent.pid .agent-session.env
echo
echo "[Agent] Stopped."
