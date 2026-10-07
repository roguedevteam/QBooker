-- "How patients join" becomes account-wide: one set of rules for every location.
-- Safe to run more than once. The old locations.* columns are left in place but no longer used.
-- Run in the Supabase SQL Editor (or `npm run migrate` from /server).

alter table tenants add column if not exists channel_mode text not null default 'both';
alter table tenants add column if not exists whatsapp_updates_offer boolean not null default true;
alter table tenants add column if not exists onsite_only boolean not null default false;
alter table tenants drop constraint if exists tenants_channel_mode_check;
alter table tenants add constraint tenants_channel_mode_check check (channel_mode in ('whatsapp','web','both'));

-- Backfill: if any of the tenant's locations has a non-default value, carry the earliest such
-- location's values over (so a clinic that had set something keeps it). Only touches tenants still
-- at the defaults, so re-running never overwrites a setting saved at account level.
update tenants t set
  channel_mode = l.channel_mode,
  whatsapp_updates_offer = l.whatsapp_updates_offer,
  onsite_only = l.onsite_only
from (
  select distinct on (tenant_id) tenant_id, channel_mode, whatsapp_updates_offer, onsite_only
  from locations
  where channel_mode <> 'both' or whatsapp_updates_offer = false or onsite_only = true
  order by tenant_id, created_at, id
) l
where l.tenant_id = t.id
  and t.channel_mode = 'both' and t.whatsapp_updates_offer = true and t.onsite_only = false;
