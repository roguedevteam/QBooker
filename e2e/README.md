# QBooker end-to-end suite

Real chromium (Playwright for Python), real API, real Postgres. No mocks.

    python3 e2e/e2e.py                      # build, serve, run A-E at phone + desktop, stop everything
    python3 e2e/e2e.py --vp phone --only A,C --skip-build --screens

Options: `--vp phone,desktop`, `--only A,B,C,D,E`, `--skip-build` (reuse /tmp/e2e/<app> builds if they match the current URLs),
`--screens` (save a screenshot of every screen to /tmp/e2e/screens), `--headed`, and `--*-url` options to use
already-running servers instead of starting your own.

## What it does
- Builds marketing, customer-admin, staff and customer with `npx vite build --outDir /tmp/e2e/<app>` and serves the dists on free ports.
- Starts a private API instance (port 4210+) against the throwaway test Postgres, preloading `dns-stub.mjs`
  (fake MX lookup, since the sandbox has no DNS) with CORS set to the app origins. It never touches Supabase or restarts the shared API on 4100.
- Everything is created under unique `e2e-<run id>` names; other tenants are never deleted.
- Journeys: A sign-up, B customer-admin, C patient app, D staff kiosk, E cross-app flow, X server log / final sweep.
- Per screen: horizontal overflow, 44px touch targets (phone), page errors/failed requests, focus visibility, basic a11y.

## Output
/tmp/e2e/report.txt, report.json, shots/ (failure screenshots), api.log. Exit code is 1 if any check fails.

## Prerequisites
node + `npm install` in each app, python `playwright` with chromium in PLAYWRIGHT_BROWSERS_PATH, psql access to the test DB.

## Caveats
- Full phone+desktop run takes >2 minutes; run per viewport if your shell has a timeout.
- Closed/after-hours fixtures need local time after 00:30. The server uses the UTC date; today's hours are set via the API
  because the UI grid stops at 19:30 and freezes past blocks.
- Not covered: print/QR windows, real WhatsApp/email, the system-admin app.
