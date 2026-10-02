-- Onboarding tracking for the guided first-login flow.
-- Default true + backfill so existing tenants (who already have data) never
-- get forced back through the wizard; new signups explicitly insert false/false.

alter table tenants add column if not exists onboarding_completed boolean not null default true;
alter table tenants add column if not exists staff_invited boolean not null default true;
