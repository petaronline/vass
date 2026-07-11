#!/bin/sh
# Supervisor for Vass backend container.
# Runs the API server and the worker as parallel child processes.
# Exits if either child dies, so Docker restarts the container.

set -e

echo "[supervise] starting Vass backend container"
echo "[supervise]   - API server"
echo "[supervise]   - launch worker"

# Start both. Each pipes through a sed prefix so logs are distinguishable.
node dist/server.js 2>&1 | sed -u 's/^/[api] /' &
API_PID=$!

node dist/worker.js 2>&1 | sed -u 's/^/[worker] /' &
WORKER_PID=$!

# Forward SIGTERM to both children for graceful shutdown
shutdown() {
  echo "[supervise] shutdown requested"
  kill -TERM "$API_PID" 2>/dev/null || true
  kill -TERM "$WORKER_PID" 2>/dev/null || true
  wait "$API_PID" "$WORKER_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Wait for either to die — when one does, kill the other & exit
# so Docker restarts the whole container.
wait -n "$API_PID" "$WORKER_PID"
EXIT_CODE=$?
echo "[supervise] a child process exited with code $EXIT_CODE — shutting down container"
kill -TERM "$API_PID" "$WORKER_PID" 2>/dev/null || true
wait "$API_PID" "$WORKER_PID" 2>/dev/null || true
exit $EXIT_CODE
