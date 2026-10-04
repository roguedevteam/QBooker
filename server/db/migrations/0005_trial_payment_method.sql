-- New signups start on a free 2-day trial with no payment details.
alter table tenants drop constraint if exists tenants_payment_method_check;
alter table tenants add constraint tenants_payment_method_check check (payment_method in ('card','invoice','later','trial'));
