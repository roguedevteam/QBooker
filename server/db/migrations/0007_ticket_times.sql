-- When a ticket was called forward and when serving finished (for the staff "seen" list).
alter table tickets add column if not exists called_at timestamptz;
alter table tickets add column if not exists finished_at timestamptz;
