-- Contact details collected at signup, alongside the existing business_name/email.
-- Safe to run multiple times.

alter table tenants add column if not exists first_name text;
alter table tenants add column if not exists last_name text;
alter table tenants add column if not exists company_address text;
