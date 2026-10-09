-- 0021: link a WhatsApp number to ONE ticket (no phone number is ever typed in or asked for).
-- The patient taps "Get updates on WhatsApp" on their ticket page; WhatsApp opens with a code (QT-XXXXXX) already typed; when they
-- press send, we receive it from their number and attach that number to the ticket. The number is the ONLY patient data held for
-- WhatsApp and it is short-lived: the sweep in lib/whatsappLinks.js clears it when the ticket is completed/seen/cancelled, when the
-- patient replies STOP, at the end of the ticket's day (location time zone), and in any case after 24 hours.
create table if not exists ticket_whatsapp_links (
  ticket_id uuid primary key references tickets(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  link_code text not null unique,
  phone_number text,
  connected_at timestamptz,
  next_notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_ticket_whatsapp_links_phone on ticket_whatsapp_links (phone_number) where phone_number is not null;
alter table ticket_whatsapp_links enable row level security;
