# QBooker end-to-end suite

Real chromium (Playwright for Python), real API, real Postgres. No mocks.

    python3 e2e/e2e.py                      # build, serve, run A-E at phone + desktop, stop everything
    python3 e2e/e2e.py --vp phone --only A,C --skip-build --screens

Options: `--vp phone,desktop`, `--only A,B,C,D,E,F`, `--skip-build` (reuse /tmp/e2e/<app> builds if they match the current URLs),
`--screens` (save a screenshot of every screen to /tmp/e2e/screens), `--headed`, and `--*-url` options to use
already-running servers instead of starting your own.

## What it does
- Builds marketing, customer-admin, staff, customer and the system-admin console (admin/, served as `sysadmin`, `--sysadmin-url`) with `npx vite build --outDir /tmp/e2e/<app>` and serves the dists on free ports.
- Starts a private API instance (port 4210+) against the throwaway test Postgres, preloading `dns-stub.mjs`
  (fake MX lookup, since the sandbox has no DNS) with CORS set to the app origins. It never touches Supabase or restarts the shared API on 4100.
- Everything is created under unique `e2e-<run id>` names; other tenants are never deleted.
- Journeys: A sign-up, B customer-admin, C patient app, D staff kiosk, E cross-app flow, F system-admin console (e2e/sysadmin.py: login, dashboard, customers list, customer detail incl. licences/staff/locations/services, pricing & sale, testing clock, session; restores the price row and clears the clock afterwards), X server log / final sweep.
- Per screen: horizontal overflow, 44px touch targets (phone), page errors/failed requests, focus visibility, basic a11y.

## Output
/tmp/e2e/report.txt, report.json, shots/ (failure screenshots), api.log. Exit code is 1 if any check fails.

## Prerequisites
node + `npm install` in each app, python `playwright` with chromium in PLAYWRIGHT_BROWSERS_PATH, psql access to the test DB.

## Caveats
- Full phone+desktop run takes >2 minutes; run per viewport if your shell has a timeout.
- Today's hours are set via the API because the UI grid stops at 19:30 and freezes past blocks.
- The private API runs on a TEST CLOCK (NODE_ENV=test + QB_TEST_NOW, default today 12:00Z; `--now ISO` to change, `--real-clock` to use the real clock), so after-hours checks are deterministic. Each location has its own time zone (default Europe/London), and the server's business day is that location's.
- Extra journeys: G accessibility (brand contrast, keyboard-only join and call-next, live regions, 320px reflow, axe), H multi-location (3 locations, isolation, archive mid-day), T midnight/BST/DST nights (moves the test clock; restores it); H also covers the customer-admin time-zone select and a New York location showing open/closed on its own clock (test clock moves, restored afterwards).
- axe-core: `npm install --no-save axe-core` in e2e/ (or E2E_AXE=/path/axe.min.js); without it the axe checks are skipped. `E2E_BASE_PORT` sets the first port (default 4210).
- Not covered: print/QR windows, real WhatsApp/email.
