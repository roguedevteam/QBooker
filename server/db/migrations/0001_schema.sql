-- QBooker schema
-- Run this in the Supabase SQL Editor, or via `npm run migrate` in /server.

create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  email text not null,
  plan_id text not null check (plan_id in ('day','week','month','year','custom')),
  plan_label text not null,
  plan_days int not null,
  active_date date,           -- day pass: the single active date
  week_start_date date,       -- week pass: start of the 7-day window
  start_date date,            -- month/year/custom: access window start
  end_date date,              -- month/year/custom: access window end
  price numeric(10,2) not null default 0,
  price_per_location numeric(10,2) not null default 0,
  location_count int not null default 1,
  access_code text not null,  -- shared staff sign-in code
  payment_method text not null check (payment_method in ('card','invoice')),
  status text not null default 'pending' check (status in ('pending','active')),
  invoice_email text,
  invoice_po text,
  created_at timestamptz not null default now()
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  address text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,
  icon text not null default 'activity',
  slot_minutes int not null default 15,
  mode text not null default 'hybrid' check (mode in ('queue','appointment','hybrid')),
  queue_paused boolean not null default false,
  queue_staff_count int not null default 2,
  created_at timestamptz not null default now()
);

-- One row per service per calendar date it has hours/staffing defined for.
-- hours is an array of minute-of-day block starts (e.g. {540,570,600} = 9:00, 9:30, 10:00).
create table if not exists service_daily_config (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references services(id) on delete cascade,
  date date not null,
  hours int[] not null default '{}',
  staff_count int not null default 2,
  booking_staff_count int not null default 1,
  unique (service_id, date)
);

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  ticket_number text not null,
  type text not null check (type in ('walk_in','booked')),
  status text not null default 'waiting' check (status in ('waiting','booked','seen','no_show','cancelled')),
  slot_time int,              -- minutes since midnight, for booked appointments
  hour_block int,             -- minutes since midnight, the walk-in block it counted against
  visit_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

-- Simulated OTP for tenant admin email sign-in (no real email is sent).
create table if not exists admin_otp (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

-- Simulated OTP for staff sign-in (paired with the tenant's shared access code).
create table if not exists staff_otp (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

-- Log of every simulated outbound email / WhatsApp message, so nothing is silently lost.
create table if not exists simulated_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp')),
  to_reference text,
  body text not null,
  created_at timestamptz not null default now()
);

-- Single-row-per-key platform configuration (pricing, etc.), edited from System Admin.
create table if not exists platform_settings (
  key text primary key,
  value jsonb not null
);

insert into platform_settings (key, value)
values ('plan_prices', '{"day":25,"week":100,"month":200,"year":600,"customDailyRate":20}')
on conflict (key) do nothing;

create index if not exists idx_locations_tenant on locations(tenant_id);
create index if not exists idx_services_tenant on services(tenant_id);
create index if not exists idx_services_location on services(location_id);
create index if not exists idx_daily_config_service_date on service_daily_config(service_id, date);
create index if not exists idx_tickets_tenant on tickets(tenant_id);
create index if not exists idx_tickets_service_date on tickets(service_id, visit_date);
create index if not exists idx_audit_tenant on audit_log(tenant_id, created_at desc);
