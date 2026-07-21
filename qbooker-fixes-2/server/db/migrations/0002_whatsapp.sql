-- Run this in the Supabase SQL Editor. Safe to run once — uses "if not exists" throughout.

-- One short code per location. This is what gets QR-coded onto posters and encoded into
-- wa.me links — e.g. QB-7F3K2A — and what the widget uses to build the right link per location.
create table if not exists location_codes (
  code text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_location_codes_location on location_codes(location_id);

-- Maps a WhatsApp phone number to whichever tenant/location they most recently scanned —
-- this is what lets one shared WhatsApp number serve many businesses. Updated every time
-- a customer sends a message containing a location code; read on every other message so
-- the conversation stays routed to the right business.
create table if not exists whatsapp_sessions (
  phone_number text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  updated_at timestamptz not null default now()
);
