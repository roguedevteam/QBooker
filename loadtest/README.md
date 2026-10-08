# QBooker load, endurance and resilience tests

Plain Node 22 scripts, no extra dependencies (they borrow `pg` / `jsonwebtoken` from `../server/node_modules`).
They only talk to the **throwaway local Postgres** (`/tmp/pgtest`, port 5433; `lib.mjs` refuses a remote DB host) and to a
private instrumented API on **:4300** (never :4100, never Supabase). Fixtures are inserted with SQL and sessions are minted with
`JWT_SECRET=testsecret`, so no DNS/sign-up is needed. Everything created is named `lt-*` and removed by `node cleanup.mjs`.

    ./loadtest/run-all.sh quick     # ~8 min, shorter durations
    ./loadtest/run-all.sh           # ~35 min; rewrites RESULTS.md

| script | scenario |
|---|---|
| `01-peak-join.mjs` | 250 patients join one hybrid service (ramp, over-capacity burst, abusive client, thundering herd) |
| `02-polling.mjs` | 300 patient pages + 5 kiosks + admin polling on a 50k-ticket DB (`IP_MODE=shared` = everyone behind one IP) |
| `03-clinic-day.mjs` | compressed clinic day with end-of-day invariant checks (exit 1 on violation) |
| `04-endurance.mjs` | `DURATION_MIN` (12) minutes steady load; RSS/heap/loop-lag/connections per third; stale-ticket sweep |
| `05-resilience.mjs` | Postgres restart / `OUTAGE_S`-second outage under load; pool exhaustion via a held advisory lock (needs `su postgres`) |
| `06-limits.mjs` | body-size limit, malformed JSON, huge header, slowloris (headers and body), idle sockets |

Helpers: `start-api.sh` (restart the instrumented API, pid in `/tmp/load/api.pid`), `instrument.mjs` (preload that samples RSS, heap,
event-loop lag, query counts into `/tmp/load/metrics.jsonl`), `seed-history.mjs` (50k tickets / 100k audit rows), `cleanup.mjs`.

Caveat: the load generator, API and Postgres share two CPUs, so read the numbers as relative (before/after, A vs B), not as capacity.
