-- Moves licensing from locations to services. A location becomes a free, unlimited
-- staff-access/customer-routing concept; a license is bought for, and permanently bound
-- to, a specific service at purchase time. Safe to run multiple times.
--
-- Pre-launch, no live customers — old location/tenant-level plan columns and the
-- location_license_purchases table are dropped outright rather than migrated.

create extension if not exists pgcrypto;

create table if not exists service_licenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  plan_id text not null,
  plan_label text not null,
  plan_days int not null,
  price numeric,
  -- available: bought, no dates yet, movable to another service.
  -- scheduled: dates assigned (may be in the future), locked to this service.
  -- active: today falls within the assigned window.
  -- expired: window has fully passed.
  -- refunded: cancelled within the refund window, before ever being scheduled.
  status text not null default 'available',
  start_date date,
  end_date date,
  purchased_at timestamptz not null default now(),
  refunded_at timestamptz
);
create index if not exists idx_service_licenses_service on service_licenses(service_id);
create index if not exists idx_service_licenses_tenant on service_licenses(tenant_id);

alter table services add column if not exists archived boolean not null default false;

-- Licensing no longer lives on locations.
alter table locations drop column if exists plan_id;
alter table locations drop column if exists plan_label;
alter table locations drop column if exists plan_days;
alter table locations drop column if exists license_price;
alter table locations drop column if exists license_not_before;
alter table locations drop column if exists start_date;
alter table locations drop column if exists end_date;
drop table if exists location_license_purchases;

-- Nor on the tenant as a whole — signup no longer sells one account-wide plan.
alter table tenants drop column if exists plan_id;
alter table tenants drop column if exists plan_label;
alter table tenants drop column if exists plan_days;
alter table tenants drop column if exists active_date;
alter table tenants drop column if exists week_start_date;
alter table tenants drop column if exists start_date;
alter table tenants drop column if exists end_date;
alter table tenants drop column if exists price;
alter table tenants drop column if exists price_per_location;
