-- Tickets still in progress when their day ends are closed automatically and flagged.
alter table tickets add column if not exists closed_by_system boolean not null default false;
