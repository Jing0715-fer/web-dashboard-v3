#!/bin/bash
cd "$(dirname "$0")"

echo
echo "Stopping Dashboard Agent..."
echo

STOPPED=0

# Method 1: PID file
if [ -f "agent.pid" ]; then
    OLD_PID=$(cat agent.pid 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[INFO] Killing PID $OLD_PID from agent.pid..."
        kill -9 "$OLD_PID" 2>/dev/null || true
        STOPPED=1
    fi
    rm -f agent.pid
fi

# Method 2: Find by port (try 3100-3109)
for try_port in $(seq 3100 3109); do
    PIDS=$(lsof -ti ":$try_port" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        for pid in $PIDS; do
            CMD=$(ps -p "$pid" -o command= 2>/dev/null || true)
            if echo "$CMD" | grep -q "agent.js"; then
                echo "[INFO] Killing process on port $try_port (PID $pid)..."
                kill -9 "$pid" 2>/dev/null || true
                STOPPED=1
            fi
        done
    fi
done

# Method 3: Find by process name
PIDS=$(pgrep -f "node agent.js" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    for pid in $PIDS; do
        echo "[INFO] Killing node agent.js (PID $pid)..."
        kill -9 "$pid" 2>/dev/null || true
        STOPPED=1
    done
fi

if [ "$STOPPED" = "1" ]; then
    echo
    echo "[OK] Agent stopped."
else
    echo "[INFO] No running agent found."
fi
echo
