#!/usr/bin/env bash
# Starts (or restarts) the private, instrumented API under test on :4300 using a pid file. Usage: start-api.sh [extra env VAR=val ...]
set -e
mkdir -p /tmp/load
PIDF=/tmp/load/api.pid
if [ -f $PIDF ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then kill "$(cat $PIDF)"; sleep 1; fi
cd "$(dirname "$0")/../server"
source test/env.sh
export PORT=4300 METRICS_FILE=/tmp/load/metrics.jsonl "$@"
nohup node --import "$(cd ../loadtest && pwd)/instrument.mjs" src/index.js > /tmp/load/api.log 2>&1 &
echo $! > $PIDF
for i in $(seq 1 40); do curl -sf localhost:4300/health >/dev/null && exit 0; sleep 0.25; done
echo "API did not start"; cat /tmp/load/api.log; exit 1
