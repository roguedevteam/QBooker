-- Named staff users per customer account. Staff sign in with their email + an emailed code.
create table if not exists staff_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_staff_members_email_unique on staff_members (lower(email));
create index if not exists idx_staff_members_tenant on staff_members (tenant_id);

alter table staff_otp add column if not exists staff_id uuid references staff_members(id) on delete cascade;
alter table staff_otp add column if not exists attempts int not null default 0;

-- Who called/served each ticket (name kept as a snapshot so reporting survives staff deletion).
alter table tickets add column if not exists called_by_staff_id uuid references staff_members(id) on delete set null;
alter table tickets add column if not exists called_by_name text;
