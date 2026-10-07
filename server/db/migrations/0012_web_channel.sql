-- Web channel alongside WhatsApp. Safe to run more than once ("if not exists" / guarded throughout).
-- Run in the Supabase SQL Editor (or `npm run migrate` from /server).

-- 1. Location-level settings: how patients can join.
alter table locations add column if not exists channel_mode text not null default 'both';
alter table locations add column if not exists whatsapp_updates_offer boolean not null default true;
alter table locations add column if not exists onsite_only boolean not null default false;
alter table locations drop constraint if exists locations_channel_mode_check;
alter table locations add constraint locations_channel_mode_check check (channel_mode in ('whatsapp','web','both'));

-- 2. Public (login-free) access to a ticket. Kept in its own table, not on tickets, because the
-- staff "list tickets" query does select * from tickets — the token and the abuse-protection
-- hashes must never travel to staff browsers. device_hash / ip_hash are salted SHA-256 hashes,
-- never raw values.
create table if not exists ticket_web_access (
  token text primary key,                          -- 24-char url-safe random (144 bits)
  ticket_id uuid not null unique references tickets(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null default 'web',
  device_hash text,
  ip_hash text,
  whatsapp_updates_requested boolean not null default false,
  whatsapp_updates_requested_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_ticket_web_access_device on ticket_web_access(device_hash);
create index if not exists idx_ticket_web_access_ip on ticket_web_access(ip_hash);

-- Lock the table away from Supabase's public REST API (anon/authenticated keys). The Express
-- server connects as the database owner, which bypasses RLS, so it is unaffected.
alter table ticket_web_access enable row level security;
