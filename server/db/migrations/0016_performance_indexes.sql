-- Indexes for the hot read paths found by load testing (50k-ticket / 100k-audit-row dataset, EXPLAIN ANALYZE).
-- All are `if not exists`, so re-running is harmless. These are plain (blocking) CREATE INDEX statements because the
-- migration runner executes each file as one multi-statement query (CONCURRENTLY is not allowed there); on today's table
-- sizes each takes well under a second, but run it in a quiet moment if the tables have grown into the millions.

-- Per-service day lookups: queue position, next ticket number, capacity counts, call-next, device/IP caps.
-- (Already present in test/schema.sql; asserted here so production is guaranteed to have it.)
create index if not exists idx_tickets_service_date on tickets (service_id, visit_date);

-- Staff kiosk / admin dashboard polling: GET /tenant/tickets (all of a tenant's tickets for a day, newest first),
-- /dashboard/stats and /today filter on tenant + day. Without this each poll scans the whole tickets table.
create index if not exists idx_tickets_tenant_date on tickets (tenant_id, visit_date, created_at desc);

-- closeStaleTickets() runs every 10 minutes AND on every GET /tenant/tickets; it only ever looks for tickets still
-- 'serving' on a past day. A tiny partial index (serving is transient) turns that full-table scan into an index probe.
create index if not exists idx_tickets_serving_day on tickets (visit_date) where status = 'serving';

-- GET /tenant/audit-log: latest 200 rows for a tenant. The log only ever grows (about two rows per ticket).
create index if not exists idx_audit_log_tenant_created on audit_log (tenant_id, created_at desc);

-- "Latest message sent to this ticket number" (customer status route) and tenant clean-up.
create index if not exists idx_simulated_messages_tenant_ref on simulated_messages (tenant_id, to_reference, created_at desc);
