#!/usr/bin/env bash
# One-command runner: ./loadtest/run-all.sh [quick]   (quick = shorter durations, ~6 min; full = ~35 min)
# Needs the throwaway Postgres on :5433 up. Starts its own instrumented API on :4300 (never :4100, never Supabase).
set -u
cd "$(dirname "$0")"
Q=${1:-full}
if [ "$Q" = quick ]; then export RAMP_S=20 DURATION_S=30 DAY_S=60 DURATION_MIN=2; fi
: > RESULTS.md
node seed-history.mjs
./start-api.sh
node 01-peak-join.mjs
node 02-polling.mjs; IP_MODE=shared TAG="(shared IP)" node 02-polling.mjs
node 03-clinic-day.mjs || echo "CLINIC DAY INVARIANT FAILURE"
./start-api.sh; node 04-endurance.mjs
./start-api.sh; node 06-limits.mjs
OUTAGE_S=0 node 05-resilience.mjs; ./start-api.sh; OUTAGE_S=12 node 05-resilience.mjs
node cleanup.mjs
