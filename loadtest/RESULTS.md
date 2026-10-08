# QBooker load / endurance / resilience results

Run 2026-10-08 on a 2-core / 8 GB sandbox: load generator, Node API and Postgres 16 all share the CPUs, so numbers are **relative**, not capacity claims.
Local Postgres (no network latency; production to Supabase adds a round trip per query). Dataset: ~56k tickets / 110k audit rows / 576 tenants.
Scenarios 1-3 were measured before the fixes described in the final report unless a section says "after"; 4 and 6 ran on the fixed server; 5 shows before and after.



### Scenario 1 - peak join
_2026-10-08T00:28:05.134Z_

**A. 250 patients ramped over 120s, capacity 300/half-hour block** (generator shares the 2 CPUs with API+DB)
| metric | value |
|---|---|
| HTTP results | {"200":250} |
| join latency ms (incl. follow-up poll) | {"n":500,"p50":7.9,"p95":12.7,"p99":22.3,"max":193.9} |
| tickets in DB / distinct numbers / highest number | 250 / 250 / 250 |
| tickets per block (max vs budget) | 250 vs 300 |
| DB connections (API) max / max active / max idle-in-tx | 3 / 1 / 1 |
| backends blocked on advisory lock, max seen | 0 |
| ungranted advisory locks after run | 0 |
| API queries / avg qps / peak qps / max in-flight | 2490 / 20.9 / 60 / 2 |
| event-loop lag p99 max / max ms | 11.5 / 13.9 |

**B. 250 patients in a 10 s burst, capacity 150**
| metric | value |
|---|---|
| HTTP results | {"200":150,"409":100} |
| latency ms | {"n":400,"p50":5,"p95":12.1,"p99":20.2,"max":26.3} |
| tickets in DB / distinct (must be <=150 and equal) | 150 / 150 |
| a further join afterwards | 409 full |
| max advisory waiters / max conns | 1 / 4 |

**C. Abuse**
| case | result |
|---|---|
| 60 joins from ONE ip, new device id each | {"200":6,"429":40,"429:too_many_ip":14} (IP rate limit first bit at request #21) |
| 6 joins, same device id, rotating IPs | {"200":2,"429:too_many_device":4} |
| 120 polls of one token from one ip in a burst (limit 90/min) | {"200":90,"429":30} |

Server log errors during scenario: 0. API RSS now 234.5 MB.


#### Scenario 1, phase D at full simultaneity (RAMP_S=1)
**D. Thundering herd: 250 patients in the same instant, one service**
| metric | value |
|---|---|
| HTTP results | {"200":250} |
| latency ms (join + poll) | {"n":500,"p50":742.6,"p95":1318.5,"p99":1349.6,"max":1353.4} |
| tickets / distinct numbers | 250 / 250 |
| max conns / max advisory waiters | 10 / 9 |
| max in-flight queries / pool connect wait max ms / event-loop lag max ms | 250 / 807.6 / 19.3 |

### Scenario 2 - polling: BEFORE (no 0016 indexes), 300 patients on distinct IPs
**60s run (before 0016 indexes, distinct IPs)**, DB holds 52332 tickets / 105471 audit rows.
| traffic | requests | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| patients (300 pages, 10 s, distinct IPs) | 1800 | 3.5 | 6.1 | 12.8 | 82 |
| staff kiosks GET /tenant/tickets (5 x 8 s) | 38 | 15.7 | 25.3 | 32.5 | 32.5 |
| staff kiosks GET /tenant/today (30 s) | 10 | 6.5 | 10.9 | 10.9 | 10.9 |
| admin GET /tenant/tickets (10 s) | 6 | 18 | 28.7 | 28.7 | 28.7 |
| admin GET /dashboard/stats (10 s) | 6 | 10.8 | 27.3 | 27.3 | 27.3 |

| metric | value |
|---|---|
| status codes | {"patient:200":1800,"kiosk:200":38,"kioskToday:200":10,"admin:200":12} |
| offered load (HTTP req/s) | 31.0 |
| DB queries/s avg / peak | 82.7 / 157  (=> ~2.7 queries per request) |
| DB connections max / max active | 6 / 1 |
| event-loop lag p99 max / max ms | 14 / 42.2 |
| failed queries / pool errors | 0 / 0 |
| log errors | 0 |

### Scenario 2 - polling: BEFORE, all 300 patients behind ONE IP (clinic wifi)
**45s run (shared IP)**, DB holds 52632 tickets / 105771 audit rows.
| traffic | requests | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| patients (300 pages, 10 s, ONE shared IP) | 1347 | 1.2 | 3.2 | 4.7 | 67.2 |
| staff kiosks GET /tenant/tickets (5 x 8 s) | 28 | 15.4 | 18.6 | 19.2 | 19.2 |
| staff kiosks GET /tenant/today (30 s) | 9 | 5.8 | 8.1 | 8.1 | 8.1 |
| admin GET /tenant/tickets (10 s) | 5 | 17.6 | 23.2 | 23.2 | 23.2 |
| admin GET /dashboard/stats (10 s) | 5 | 11.9 | 14.3 | 14.3 | 14.3 |

| metric | value |
|---|---|
| status codes | {"patient:200":90,"kiosk:200":28,"admin:200":10,"kioskToday:200":9,"patient:429":1257} |
| offered load (HTTP req/s) | 31.0 |
| DB queries/s avg / peak | 2.6 / 14  (=> ~0.1 queries per request) |
| DB connections max / max active | 5 / 1 |
| event-loop lag p99 max / max ms | 29.2 / 31.9 |
| failed queries / pool errors | 0 / 0 |
| log errors | 0 |

### Scenario 2 - polling: AFTER (migration 0016 + per-token poll limiter), distinct IPs
**60s run (after 0016 + token limiter, distinct IPs)**, DB holds 55863 tickets / 110392 audit rows.
| traffic | requests | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| patients (300 pages, 10 s, distinct IPs) | 1799 | 4.1 | 6.5 | 13.6 | 77.1 |
| staff kiosks GET /tenant/tickets (5 x 8 s) | 37 | 7 | 16.6 | 22.1 | 22.1 |
| staff kiosks GET /tenant/today (30 s) | 10 | 5.7 | 9.3 | 9.3 | 9.3 |
| admin GET /tenant/tickets (10 s) | 6 | 6.9 | 13.5 | 13.5 | 13.5 |
| admin GET /dashboard/stats (10 s) | 6 | 3.8 | 5.9 | 5.9 | 5.9 |

| metric | value |
|---|---|
| status codes | {"patient:200":1799,"kiosk:200":37,"admin:200":12,"kioskToday:200":10} |
| offered load (HTTP req/s) | 31.0 |
| DB queries/s avg / peak | 82 / 170  (=> ~2.6 queries per request) |
| DB connections max / max active | 3 / 0 |
| event-loop lag p99 max / max ms | 17.1 / 32.1 |
| failed queries / pool errors | 0 / 0 |
| log errors | 0 |

### Scenario 2 - polling: AFTER, one shared IP
**40s run (after, shared IP)**, DB holds 56463 tickets / 110992 audit rows.
| traffic | requests | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| patients (300 pages, 10 s, ONE shared IP) | 1200 | 3.8 | 5.4 | 8.9 | 72.1 |
| staff kiosks GET /tenant/tickets (5 x 8 s) | 25 | 6.3 | 9.7 | 20.9 | 20.9 |
| staff kiosks GET /tenant/today (30 s) | 6 | 4.6 | 6.6 | 6.6 | 6.6 |
| admin GET /tenant/tickets (10 s) | 4 | 7.8 | 13 | 13 | 13 |
| admin GET /dashboard/stats (10 s) | 4 | 6.7 | 7.9 | 7.9 | 7.9 |

| metric | value |
|---|---|
| status codes | {"patient:200":1200,"kiosk:200":25,"admin:200":8,"kioskToday:200":6} |
| offered load (HTTP req/s) | 31.0 |
| DB queries/s avg / peak | 75.3 / 160  (=> ~2.4 queries per request) |
| DB connections max / max active | 3 / 1 |
| event-loop lag p99 max / max ms | 12.4 / 15.1 |
| failed queries / pool errors | 0 / 0 |
| log errors | 0 |

### Scenario 2 - EXPLAIN ANALYZE before/after (execution ms, heavy tenant-day of ~7k tickets in a 52k-ticket table)
| query | before | after |
|---|---|---|
| tenant tickets for a day (kiosk/admin poll) | Seq Scan 8.9 | Index (tenant,date,created desc) 3.0 |
| dashboard stats | Seq Scan 5.8 | Index 2.1 |
| closeStaleTickets sweep (every GET /tenant/tickets) | Seq Scan 4.8 (grows with table) | partial index 0.04 |
| audit-log latest 200 | Seq Scan 8.7 | Index 0.27 |
| simulated_messages lookup | Seq Scan 2.7 | Index 0.04 |
| device/IP active-count (join path) | Seq Scan on ticket_web_access 3.0 | Index 0.14 (indexes existed in migration 0012 but not in test/schema.sql) |
| public token lookup, queue position, ticket number, ribbon | all indexed already (0.1 - 1.5 ms; ticket number scan is 12 ms at 7k tickets/day, ~0.5 ms at a realistic 300) | unchanged |


### Scenario 3 - mixed clinic day
_2026-10-08T00:46:55.171Z_

Compressed day: 150s real for 08:00-17:00, 140 walk-in attempts, 50 booking attempts, 3 staff kiosks + admin dashboard.
| activity | count |
|---|---|
| joinOk | 122 |
| joinFull | 18 |
| bookOk | 50 |
| bookFail | 0 |
| leaves | 16 |
| checkins | 26 |
| calls | 172 |
| callAgain | 15 |
| returned | 16 |
| noShow | 12 |
| closed | 144 |
| polls | 1151 |

Final ticket states: {"completed":144,"no_show":12,"cancelled":16}
HTTP outcomes: {"tickets:200":129,"callnext:404":15,"admin:200":51,"book:200":50,"poll:200":1151,"join:200":122,"callnext:200":172,"close:200":144,"noshow:200":12,"checkin:200":26,"join:409":18,"callagain:200":15,"return:200":16,"leave:200":16}

| call | n | p50 | p95 | p99 | max (ms) |
|---|---|---|---|---|---|
| join | 140 | 9.6 | 15.2 | 16.4 | 20.3 |
| book | 50 | 7.8 | 11.9 | 27.4 | 27.4 |
| poll | 1151 | 3.7 | 5.5 | 9.3 | 18.2 |
| call | 187 | 5.1 | 10.1 | 92.5 | 94.4 |
| close | 144 | 5.4 | 9 | 11.3 | 12.7 |
| tickets | 129 | 16 | 27.1 | 75.5 | 112 |

DB: max conns 8, max advisory waiters 0; API: 42.9 qps avg / 96 peak, loop lag max 20.1 ms, RSS 256.3 MB.

**Invariants**
| check | result | detail |
|---|---|---|
| ticket count equals successful joins+bookings | PASS | db 172 vs client 172 |
| no duplicate ticket numbers | PASS | 0 duplicates |
| every ticket in a coherent state (serving has called_at & no finished_at; completed has called_at; waiting/booked never called) | PASS | 0 incoherent:  |
| no ticket left 'serving' | PASS | 0 left |
| no ticket served twice (calls minus returns-to-queue <= 1 per ticket) | PASS | 0 tickets called more than once without being returned |
| every completed ticket was called via call-next | PASS | 0 |
| walk-in capacity per half-hour block never exceeded (budget 9) | PASS | max 9 in block 510 |
| bookings per slot never exceed booking staff (2) | PASS | max 2 at slot 530 |
| dashboard stats equal database counts | PASS | {"waiting":0,"booked":0,"serving":0,"completed":144,"no_show":12,"cancelled":16} |
| audit log matches client counts (joins, bookings, calls) | PASS | audit j/b/c 122/50/172 vs client 122/50/172 |
| no advisory locks or idle-in-transaction sessions left | PASS | advisory 0, idle-in-tx 0 |
| no 5xx / connection errors from the API | PASS | [] |
| server log clean | PASS |  |

### Scenario 4 - endurance (12 min)
_2026-10-08T01:20:24.454Z_

12 patient workers + 2 staff + admin, 8421 requests (~12 req/s), distinct random client IP/device each visit.
HTTP outcomes: {"200":8411,"404":2,"409":8}

| window | RSS avg MB | heap min MB (post-GC floor) | heap max MB | loop lag p99 max ms | handles max | poll latency p50/p95/p99 ms |
|---|---|---|---|---|---|---|
| third 1 | 259.1 | 13.5 | 32.1 | 16.7 | 27 | 4.1/5.8/8.8 |
| third 2 | 266.7 | 14.1 | 32.7 | 21.2 | 8 | 4/5.3/9.8 |
| third 3 | 271.1 | 14 | 32.6 | 22.3 | 8 | 4/5.4/13.2 |

RSS growth over the last two thirds: 0.83 MB/min (start 266.8 MB -> end 270.9 MB).
DB connections held by API: max 10, idle-in-tx max 1; failed queries 0, pool errors 0.
closeStaleTickets: planted 12 stale 'serving' tickets from yesterday; still serving at end: 0; closed_by_system: 12.
Server log errors / unhandled rejections: 0

### Scenario 5 - DB resilience BEFORE the fix (original pool.js)
**R1. Postgres restarted under ~50 req/s of mixed traffic**
| metric | value |
|---|---|
| pg_ctl restart took | 0.3 s |
| API process survived (same pid, answers /health) | false / false (pid 474 -> 474) |
| all statuses seen from restart until recovery | {"200":11,"UND_ERR_SOCKET":3,"ECONNREFUSED":11720} |
| non-200 responses with a JSON body | 0 of 11723 |
| traffic fully healthy again at | NEVER (within 60 s) |
| slowest response during outage | 338 ms |
| API RSS after | null MB |

Server log lines matching error/unhandled: 14
```
      throw er; // Unhandled 'error' event
error: terminating connection due to administrator command
    at parseErrorMessage (/home/claude/qbooker/server/node_modules/pg-protocol/dist/parser.js:306:11)
Emitted 'error' event on BoundPool instance at:
    at Client._handleErrorEvent (/home/claude/qbooker/server/node_modules/pg/lib/client.js:422:10)
    at Client._handleErrorMessage (/home/claude/qbooker/server/node_modules/pg/lib/client.js:433:12)
  severity: 'FATAL',
    _events: [Object: null prototype] { error: [Function (anonymous)] },
```


The API process crashed with an unhandled pool `error` event ("terminating connection due to administrator command") and never came back.


### Scenario 5 - DB resilience AFTER (R1: 12 s Postgres outage; R2 pool exhaustion)
**R1. Postgres down for 12 s under ~50 req/s of mixed traffic**
| metric | value |
|---|---|
| Postgres stopped for 12s then started: took | 12.2 s |
| API process survived (same pid, answers /health) | true / true (pid 7786 -> 7786) |
| all statuses seen from restart until recovery | {"200":407,"409":72,"503":1825} |
| non-200 responses with a JSON body | 1825 of 1825 |
| traffic fully healthy again at | 3 s after Postgres was back (15 s after restart began) |
| last 5xx/connection failure seen | 0 s after Postgres was back |
| slowest response during outage | 132 ms |
| API RSS after | 270.5 MB |

Server log lines matching error/unhandled: 4
```
[db] connection error (pool will reconnect): 57P01 terminating connection due to administrator command
[db] unavailable (503s are being sent; logged at most every 5 s): ECONNREFUSED connect ECONNREFUSED 127.0.0.1:5433
```

**R2. Pool exhaustion: 40 joins blocked on a held per-service advisory lock (pool max 10 by default)**
| metric | value |
|---|---|
| unrelated patient polls issued while clogged (statuses / latency ms) | {"200":6} / {"n":6,"p50":4.4,"p95":5.7,"p99":5.7,"max":5.7} |
| /health while clogged | 200 in 2 ms (does not touch the DB) |
| blocked joins: results after waiting up to 35 s with the lock still held | {"503":40} |
| blocked joins: slowest | 16018 ms |
| after releasing the lock: normal poll | 200 in 5 ms |

Server log lines matching error/unhandled (whole scenario): 4


#### R1 with a plain sub-second `pg_ctl restart`: no failed requests at all (200 only), process stayed up, one throttled `[db] connection error` log line.


### Scenario 6 - body limit and slow clients
_2026-10-08T01:05:05.078Z_

| case | result |
|---|---|
| POST 90 kB JSON | 404 No account found with that email. |
| POST 200 kB JSON | 413 That request is too large. |
| POST 5 MB JSON | 413 That request is too large. |
| malformed JSON | 400 The request body isn't valid JSON. |
| one 20 kB header | 431 |
| slowloris: headers never finished | closed by server after 18.5 s HTTP/1.1 408 Request Timeout |
| slow body: 1 byte / 5 s, 1000 declared | closed by server after 35.0 s HTTP/1.1 408 Request Timeout |
| 300 idle open sockets, then /health | 200 in 5 ms |
| server log errors | 0 |

Before the change the server used Node defaults (headers 60 s, whole request 300 s, checked only every 30 s), so a slow socket could be held for 1.5 to 5+ minutes; not re-measured at stock settings.
