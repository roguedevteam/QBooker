-- Payment is tracked per license: card licenses are paid on purchase, invoice (or pay-later)
-- licenses stay unpaid until system admin marks them paid. Free/granted licenses have no method.
alter table service_licenses add column if not exists payment_method text;
alter table service_licenses add column if not exists paid boolean not null default true;
alter table service_licenses add column if not exists paid_at timestamptz;
alter table service_licenses add column if not exists invoice_po text;

-- Licenses that belong to accounts still waiting on payment become unpaid invoice/pay-later licenses.
update service_licenses l set payment_method = t.payment_method, paid = false, invoice_po = t.invoice_po
from tenants t where t.id = l.tenant_id and t.status = 'pending' and coalesce(l.price,0) > 0;
update service_licenses l set payment_method = 'card' where payment_method is null and coalesce(price,0) > 0 and paid = true;
