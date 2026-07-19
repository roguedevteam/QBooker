# QBooker — Supabase + Render deployment

One backend, five frontends — one URL per audience:

| App | Who it's for | Local port | Login |
|---|---|---|---|
| `/server` | — (the API, talks to the database) | 4000 | — |
| `/marketing` | Public visitors | 5175 | none |
| `/customer-admin` | The business owner / their team | 5173 | Email + OTP, persistent (30 days) |
| `/staff` | Front-of-house staff | 5176 | Access code + OTP, persistent (10h shift) |
| `/customer` | End customers (the WhatsApp simulator) | 5177 | **none** — public link, `?t=<businessId>` |
| `/admin` | QBooker's own platform team (System Admin) | 5174 | Password, not linked from anywhere else |

Supabase is used purely as the Postgres database — not Supabase Auth. All sign-in codes are
simulated (shown on screen, logged to `simulated_messages`) rather than emailed for real, so the
Express API enforces access itself.

## How the apps find each other

- `/marketing`'s signup success screen links to `/customer-admin`'s sign-in (`VITE_ADMIN_APP_URL`).
- `/customer-admin`'s header links back to `/marketing` for new sign-ups (`VITE_MARKETING_URL`),
  and its Locations tab shows the `/staff` URL + access code, and a copyable `/customer` link
  (`VITE_STAFF_APP_URL`, `VITE_CUSTOMER_APP_URL`).
- `/customer` has no login — a real deployment would put a link like
  `https://your-customer-app.com/?t=<tenantId>` on a poster/QR code/WhatsApp bio for each business.
  The tenant ID isn't secret (it's a UUID, and the data behind it is just service names and
  opening hours), but it's also not searchable or guessable.
- `/admin` links to and from nothing.

## 1. Supabase

Schema in `server/db/migrations/0001_schema.sql` — already run if you've been following along.

## 2. Server

```bash
cd server
cp .env.example .env
npm install
npm run migrate
npm run dev              # http://localhost:4000
```

`CORS_ORIGIN` needs all five frontend origins (see the table above for ports).

## 3. The five frontends

Each needs its own terminal and its own `.env` (copy from `.env.example` in each folder):

```bash
cd marketing      && npm install && npm run dev   # :5175
cd customer-admin  && npm install && npm run dev   # :5173
cd staff           && npm install && npm run dev   # :5176
cd customer        && npm install && npm run dev   # :5177
cd admin           && npm install && npm run dev   # :5174
```

**Testing the full loop locally**: sign up on `:5175` → verify on `:5173` → open Locations tab,
copy the customer link → paste it into a new tab (or open `:5177/?t=<id>` directly) → join a
queue → open `:5176`, sign in with the access code shown, call the ticket forward.

## 4. Deploy

`render.yaml` defines all six services. Push to GitHub, then in Render: New → Blueprint.

Fill in the `sync: false` env vars per service (see the table/links above for which URL goes
where) — you'll have all five frontend URLs once Render's created them, so it's easiest to deploy
once, then go back and fill in the cross-links between services, then redeploy (Render redeploys
automatically on env var changes).

Run the migration once against production too.

---

## What's real

- Five independently deployable apps, cleanly separated by audience, sharing one API.
- **New public, unauthenticated customer API** (`/api/public/tenant/:tenantId/...`) — the
  WhatsApp simulator no longer piggybacks on an admin login to read services, which is what it
  was doing before this split and wouldn't have worked once truly separated.
- Persistent sessions (customer-admin: 30 days, staff: 10h/shift), simulated testing clock
  (System Admin → Testing tab, affects every app since it's server-side), locking, drag-to-paint
  calendar, buy-another-location, full staff ticket actions — all as previously built.

## What's simulated / simplified — same as before

- Emails and WhatsApp — logged, not really sent.
- Payments — tracked, not charged.
- Polling (8–10s), not realtime.
- Single shared System Admin password; no OTP rate limiting yet.
