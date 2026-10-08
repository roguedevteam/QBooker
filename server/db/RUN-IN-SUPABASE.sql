-- QBooker: paste ALL of this into Supabase > SQL Editor > New query, then click Run. Safe to run twice.
-- Account hardening.
-- 1) token_version: bumping it signs a person out everywhere (every session token carries the version it was
--    issued under; a token whose version no longer matches is refused). Used by "sign out everywhere", by
--    switching a staff member off, and as the building block for any future "revoke sessions" feature.
alter table tenants       add column if not exists token_version integer not null default 0;
alter table staff_members add column if not exists token_version integer not null default 0;

-- 2) Sign-in codes are now stored as a keyed hash (HMAC-SHA256, 64 hex characters), never in clear. Any code
--    still waiting from before this change is in clear text and would no longer verify anyway, so remove it.
delete from admin_otp;
delete from staff_otp;

-- 3) The simulated message log used to keep the full text of sign-in emails, codes included. Scrub those.
update simulated_messages
   set body = '[sign-in code removed]'
 where channel = 'email' and body ~* 'sign-in code';

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
