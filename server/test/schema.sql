-- Test-only schema mirroring the live public schema (migrations 0002+ are not applied on top of this).
create extension if not exists pgcrypto;
create table tenants (id uuid primary key default gen_random_uuid(), business_name text not null, email text not null, location_count integer not null default 1, access_code text not null, payment_method text not null check (payment_method in ('card','invoice','later','trial')), status text not null default 'pending' check (status in ('pending','active','disabled')), invoice_email text, invoice_po text, created_at timestamptz not null default now(), website_url text, onboarding_completed boolean not null default true, staff_invited boolean not null default true, first_name text, last_name text, company_address text, dismissed_setup_tasks text[] not null default '{}', signup_country text, channel_mode text not null default 'both' check (channel_mode in ('whatsapp','web','both')), whatsapp_updates_offer boolean not null default true, onsite_only boolean not null default false);
create table locations (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, name text not null, address text not null default '', created_at timestamptz not null default now(), website_url text, staff_access_code text, archived boolean not null default false, channel_mode text not null default 'both' check (channel_mode in ('whatsapp','web','both')), whatsapp_updates_offer boolean not null default true, onsite_only boolean not null default false);
create table services (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, name text not null, icon text not null default 'activity', slot_minutes integer not null default 15, mode text not null default 'hybrid' check (mode in ('queue','appointment','hybrid')), queue_paused boolean not null default false, queue_staff_count integer not null default 2, created_at timestamptz not null default now(), archived boolean not null default false);
create table staff_members (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, first_name text not null, last_name text not null, email text not null, created_at timestamptz not null default now(), active boolean not null default true);
create table tickets (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, service_id uuid not null references services(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, ticket_number text not null, type text not null check (type in ('walk_in','booked')), status text not null default 'waiting' check (status in ('waiting','booked','seen','serving','completed','no_show','cancelled')), slot_time integer, hour_block integer, visit_date date not null default ((now() at time zone 'Europe/London')::date), created_at timestamptz not null default now(), called_at timestamptz, finished_at timestamptz, called_room text, called_by_staff_id uuid references staff_members(id) on delete set null, called_by_name text, closed_by_system boolean not null default false, arrived_at timestamptz);
create table audit_log (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, message text not null, created_at timestamptz not null default now());
create table deleted_tenant_revenue (id uuid primary key default gen_random_uuid(), original_tenant_id uuid not null, business_name text, signed_up_at timestamptz, deleted_at timestamptz not null default now(), total_revenue numeric not null default 0, pending_revenue numeric not null default 0, license_count integer not null default 0, location_count integer not null default 0, revenue_by_plan jsonb not null default '{}');
create table location_codes (code text primary key, tenant_id uuid not null references tenants(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, created_at timestamptz not null default now());
create table admin_otp (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, code text not null, expires_at timestamptz not null, consumed boolean not null default false, created_at timestamptz not null default now(), attempts integer not null default 0);
create table platform_settings (key text primary key, value jsonb not null);
create table service_daily_config (id uuid primary key default gen_random_uuid(), service_id uuid not null references services(id) on delete cascade, date date not null, hours integer[] not null default '{}', staff_count integer not null default 2, booking_staff_count integer not null default 1, walkin_staff_count integer not null default 0, unique (service_id, date));
create table service_licenses (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, service_id uuid not null references services(id) on delete cascade, plan_id text not null, plan_label text not null, plan_days integer not null, price numeric, status text not null default 'available', start_date date, end_date date, purchased_at timestamptz not null default now(), refunded_at timestamptz, payment_method text, paid boolean not null default true, paid_at timestamptz, invoice_po text, scheduled_at timestamptz);
create table simulated_messages (id uuid primary key default gen_random_uuid(), tenant_id uuid references tenants(id) on delete cascade, channel text not null check (channel in ('email','whatsapp')), to_reference text, body text not null, created_at timestamptz not null default now());
create table staff_otp (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, code text not null, expires_at timestamptz not null, consumed boolean not null default false, created_at timestamptz not null default now(), staff_id uuid references staff_members(id) on delete cascade, attempts integer not null default 0);
create table ticket_web_access (token text primary key, ticket_id uuid not null unique references tickets(id) on delete cascade, tenant_id uuid not null references tenants(id) on delete cascade, channel text not null default 'web', device_hash text, ip_hash text, whatsapp_updates_requested boolean not null default false, whatsapp_updates_requested_at timestamptz, created_at timestamptz not null default now());
create table whatsapp_sessions (phone_number text primary key, tenant_id uuid not null references tenants(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, updated_at timestamptz not null default now());
create unique index idx_locations_staff_access_code on locations(staff_access_code) where staff_access_code is not null;
create unique index idx_tenants_email_unique on tenants(lower(email));
create unique index idx_staff_members_email_unique on staff_members(lower(email));
create index idx_tickets_service_date on tickets(service_id, visit_date);
-- Indexes that production has via migrations 0002/0004/0009/0012 (missing here until now, which made local timings pessimistic):
create index idx_location_codes_location on location_codes(location_id);
create index idx_service_licenses_service on service_licenses(service_id);
create index idx_service_licenses_tenant on service_licenses(tenant_id);
create index idx_staff_members_tenant on staff_members(tenant_id);
create index idx_ticket_web_access_device on ticket_web_access(device_hash);
create index idx_ticket_web_access_ip on ticket_web_access(ip_hash);
-- Migration 0016 (load-test indexes):
create index idx_tickets_tenant_date on tickets (tenant_id, visit_date, created_at desc);
create index idx_tickets_serving_day on tickets (visit_date) where status = 'serving';
create index idx_audit_log_tenant_created on audit_log (tenant_id, created_at desc);
create index idx_simulated_messages_tenant_ref on simulated_messages (tenant_id, to_reference, created_at desc);

-- 0018: session versions (sign out everywhere / revoke on disable)
alter table tenants add column if not exists token_version integer not null default 0;
alter table staff_members add column if not exists token_version integer not null default 0;

-- 0019: time zones, currency, ticket prefixes (verbatim copy of db/migrations/0019_timezones_currency_ticket_prefix.sql)
-- 0019: global groundwork - per-location time zone, tenant currency, platform billing config, and
-- unambiguous ticket numbers. Safe to run multiple times; written to be safe on live data.
--
-- 1. TIME ZONES. Every existing location is a UK clinic, so every existing row is backfilled to
--    'Europe/London' (the column default does that for us, nothing about current behaviour changes).
--    locations.timezone is the IANA zone the clinic's opening hours are written in; tenants.default_timezone
--    is what a NEW location starts with. The API validates names (Intl + this database's own list); the
--    trigger below stops a bad value written any other way (psql, an import) from ever breaking
--    `at time zone` in the end-of-day sweep.
-- 2. CURRENCY. tenants.currency is the ISO 4217 code the account is billed in (display only: prices are
--    not converted). Platform-wide defaults (currency, VAT rate and label) live in platform_settings 'billing'.
-- 3. TICKET NUMBERS. A ticket number was "<initials of the service name>-<n>" counted per SERVICE, so two services
--    at one site with the same initials ("Dental Care", "Diabetic Clinic") both issued DC-001 on the same day.
--    Each service now owns a short, stable ticket_prefix, unique within its location (DC, then DCA, DCB ...), and
--    numbers are counted per (location, day, prefix). Existing duplicate numbers are renumbered first, then a
--    unique index on (location_id, visit_date, ticket_number) guarantees it.
-- tickets.visit_date keeps its 0017 default (the London date) purely as a safety net for writers that do not
-- supply a date; the API always supplies the date from the SERVICE'S LOCATION time zone.

alter table tenants add column if not exists default_timezone text not null default 'Europe/London';
alter table tenants add column if not exists currency text not null default 'GBP';
alter table locations add column if not exists timezone text not null default 'Europe/London';

update locations set timezone = 'Europe/London' where timezone is null or btrim(timezone) = '';
update tenants set default_timezone = 'Europe/London' where default_timezone is null or btrim(default_timezone) = '';

alter table locations drop constraint if exists locations_timezone_shape;
alter table locations add constraint locations_timezone_shape check (timezone ~ '^[A-Za-z0-9_+/-]{1,64}$');
alter table tenants drop constraint if exists tenants_default_timezone_shape;
alter table tenants add constraint tenants_default_timezone_shape check (default_timezone ~ '^[A-Za-z0-9_+/-]{1,64}$');
alter table tenants drop constraint if exists tenants_currency_shape;
alter table tenants add constraint tenants_currency_shape check (currency ~ '^[A-Z]{3}$');

create or replace function qb_check_timezone() returns trigger language plpgsql as $$
declare tz text := to_jsonb(new) ->> TG_ARGV[0];
begin
  if not exists (select 1 from pg_timezone_names where name = tz) then
    raise exception 'unknown time zone: %', tz using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_locations_timezone on locations;
create trigger trg_locations_timezone before insert or update of timezone on locations
  for each row execute function qb_check_timezone('timezone');
drop trigger if exists trg_tenants_default_timezone on tenants;
create trigger trg_tenants_default_timezone before insert or update of default_timezone on tenants
  for each row execute function qb_check_timezone('default_timezone');

insert into platform_settings (key, value)
values ('billing', '{"currency":"GBP","vatRate":0.2,"vatLabel":"VAT"}'::jsonb)
on conflict (key) do nothing;

-- Ticket prefixes ---------------------------------------------------------------------------------------
alter table services add column if not exists ticket_prefix text;

-- The prefix a service should have: the initials of its first two words ("Dental Care" -> DC), or SV if the
-- name has none; if another service at the same location already owns it, a letter is added (DCA, DCB, ...).
create or replace function qb_ticket_prefix_for(p_location uuid, p_name text, p_self uuid) returns text
language plpgsql as $$
declare base text; cand text; i int;
begin
  select coalesce(nullif(upper(string_agg(r.m[2], '' order by r.ord)), ''), 'SV') into base
  from regexp_matches(coalesce(p_name, ''), '(^|[^[:alnum:]])([[:alnum:]])', 'g') with ordinality as r(m, ord)
  where r.ord <= 2;
  if base is null then base := 'SV'; end if;
  cand := base;
  if not exists (select 1 from services where location_id = p_location and ticket_prefix = cand and id is distinct from p_self) then return cand; end if;
  for i in 0..25 loop
    cand := base || chr(65 + i);
    if not exists (select 1 from services where location_id = p_location and ticket_prefix = cand and id is distinct from p_self) then return cand; end if;
  end loop;
  i := 1;
  loop
    cand := base || i::text;
    if not exists (select 1 from services where location_id = p_location and ticket_prefix = cand and id is distinct from p_self) then return cand; end if;
    i := i + 1;
  end loop;
end $$;

create or replace function qb_services_set_prefix() returns trigger language plpgsql as $$
begin
  if new.ticket_prefix is null or btrim(new.ticket_prefix) = '' then
    perform pg_advisory_xact_lock(hashtext('ticket-prefix|' || new.location_id::text));
    new.ticket_prefix := qb_ticket_prefix_for(new.location_id, new.name, new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_services_ticket_prefix on services;
create trigger trg_services_ticket_prefix before insert on services
  for each row execute function qb_services_set_prefix();

-- Backfill, oldest service first so the earliest one at a location keeps the plain initials.
do $$
declare s record;
begin
  for s in select id, location_id, name from services where ticket_prefix is null or btrim(ticket_prefix) = '' order by created_at, id loop
    update services set ticket_prefix = qb_ticket_prefix_for(s.location_id, s.name, s.id) where id = s.id;
  end loop;
end $$;
alter table services alter column ticket_prefix set not null;
create unique index if not exists idx_services_location_ticket_prefix on services (location_id, ticket_prefix);

-- Existing duplicate numbers on one location-day: the earliest ticket keeps its number, later ones are renumbered
-- after the highest number already issued with that prefix that day, and the change is written to the audit log.
with ranked as (
  select id, tenant_id, location_id, visit_date, ticket_number, created_at,
         regexp_replace(ticket_number, '-\d+$', '') as pfx,
         row_number() over (partition by location_id, visit_date, ticket_number order by created_at, id) as rn
  from tickets
), mx as (
  select location_id, visit_date, pfx, max(coalesce(substring(ticket_number from '-(\d+)$')::int, 0)) as m
  from ranked group by location_id, visit_date, pfx
), dup as (
  select r.id, r.tenant_id, r.location_id, r.visit_date, r.pfx, r.ticket_number as old_number,
         row_number() over (partition by r.location_id, r.visit_date, r.pfx order by r.created_at, r.id) as k
  from ranked r where r.rn > 1
), upd as (
  update tickets t
     set ticket_number = d.pfx || '-' || lpad((mx.m + d.k)::text, 3, '0')
    from dup d join mx on mx.location_id = d.location_id and mx.visit_date = d.visit_date and mx.pfx = d.pfx
   where t.id = d.id
  returning d.tenant_id, d.old_number, t.ticket_number as new_number, d.visit_date
)
insert into audit_log (tenant_id, message)
select tenant_id, 'Ticket ' || old_number || ' (' || visit_date::text || ') renumbered to ' || new_number || ' - the number had been issued twice at this location that day'
from upd;

create unique index if not exists idx_tickets_location_day_number on tickets (location_id, visit_date, ticket_number);
create table signup_otp (id uuid primary key default gen_random_uuid(), email text not null, code text not null, expires_at timestamptz not null, consumed boolean not null default false, attempts integer not null default 0, created_at timestamptz not null default now());
create index idx_signup_otp_email on signup_otp (lower(email), created_at desc);
