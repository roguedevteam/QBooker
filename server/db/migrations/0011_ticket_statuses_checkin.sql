-- "seen" is split into "serving" (called, not finished) and "completed" (finished); booked
-- customers can check in (arrived_at). "seen" stays allowed by the constraint so a server that
-- hasn't been redeployed yet doesn't break while this is rolled out.
alter table tickets drop constraint if exists tickets_status_check;
alter table tickets add constraint tickets_status_check check (status in ('waiting','booked','seen','serving','completed','no_show','cancelled'));
alter table tickets add column if not exists arrived_at timestamptz;
update tickets set status='serving' where status='seen' and called_at is not null and finished_at is null;
update tickets set status='completed' where status='seen';
