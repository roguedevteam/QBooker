-- Staff can be switched off (and back on) without deleting them.
alter table staff_members add column if not exists active boolean not null default true;
-- When a licence's dates were last assigned (used to give same-day set-up a grace period).
alter table service_licenses add column if not exists scheduled_at timestamptz;
