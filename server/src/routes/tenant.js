import { Router } from "express";
import { query, pool } from "../db/pool.js";
import { requireAuth } from "../lib/auth.js";
import { genAccessCode, logSimulatedMessage } from "../lib/simulate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createLocationCode } from "../lib/codes.js";
import {
  currentHourBlock, buildTodayRibbon, BLOCK_MINUTES,
} from "../lib/scheduling.js";
import { isDateFullyPast, addDays } from "../lib/plan.js";
import { getToday, londonNowMinutes } from "../lib/clock.js";
import { dayCfg, getAvailability, loadService as loadServiceForTenant } from "../lib/availability.js";
import { createTicket, parseTicketRequest } from "../lib/tickets.js";
import {
  badRequest, notFound, conflict, isUuid, uuidParams, reqDate, optDate, reqString, optString, optEmail, optInt, optBool, optEnum,
  clockMinutesOrUndefined, parseHours, EMAIL_RE,
} from "../lib/validate.js";
import {
  resolveServiceLicenses, resolveServiceLicense, activeAndScheduledWindows,
  isServiceLicensedOn, checkSchedulable, computeEndDate, isWithinRefundWindow,
  planPricing, resolvePlan,
} from "../lib/serviceLicense.js";
import { snapshotAndDeleteTenant } from "../lib/tenantDeletion.js";
import { sanitizeTenant } from "../lib/tenantView.js";
import { domainAcceptsMail } from "../lib/emailCheck.js";
import { closeStaleTickets } from "../lib/closeStaleTickets.js";

const router = Router();
uuidParams(router, "id", "licenseId");

router.use(requireAuth("tenant_admin", "staff"));

async function loadTenant(req, res, next) {
  const result = await query(`select * from tenants where id=$1`, [req.auth.tenantId]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Account not found." });
  // Blocks an already-issued token too, not just a fresh login — otherwise disabling an
  // account mid-session wouldn't actually do anything until the token expired on its own.
  if (result.rows[0].status === "disabled") {
    return res.status(403).json({ error: "This account has been disabled — contact us to unlock it." });
  }
  req.tenant = result.rows[0];
  // A staff session must belong to a staff member who still exists — deleting someone from the
  // staff list ends their session immediately instead of waiting for the token to expire.
  if (req.auth.role === "staff") {
    const staff = req.auth.staffId
      ? (await query(`select * from staff_members where id=$1 and tenant_id=$2 and active=true`, [req.auth.staffId, req.auth.tenantId])).rows[0]
      : null;
    if (!staff) return res.status(401).json({ error: "Session expired or invalid — please sign in again." });
    req.staff = staff;
  }
  next();
}
router.use(asyncHandler(loadTenant));

function staffName(req) {
  return req.staff ? `${req.staff.first_name} ${req.staff.last_name}` : null;
}

function adminOnly(req, res, next) {
  if (req.auth.role !== "tenant_admin") return res.status(403).json({ error: "Admin only." });
  next();
}

router.get("/me", (req, res) => res.json({
  tenant: sanitizeTenant(req.tenant, req.auth.role),
  staff: req.staff ? { id: req.staff.id, firstName: req.staff.first_name, lastName: req.staff.last_name, email: req.staff.email } : null,
}));

// --- Staff users (customer admin manages who can sign in to the staff portal) ----------
async function validateStaffBody(req, { requireAll }) {
  const first = optString(req.body.firstName, "First name", { max: 100 });
  const last = optString(req.body.lastName, "Last name", { max: 100 });
  const email = optString(req.body.email, "Email", { max: 254 });
  if (requireAll && (!first || !last || !email)) throw badRequest("First name, last name and email are all required.");
  if (email !== undefined) {
    if (!EMAIL_RE.test(email)) throw badRequest("Enter a valid email address.");
    if (!(await domainAcceptsMail(email))) throw badRequest("That email address doesn't look like it can receive mail — check for a typo.");
  }
  return { first, last, email };
}
router.get("/staff", adminOnly, asyncHandler(async (req, res) => {
  const r = await query(`select id, first_name, last_name, email, active, created_at from staff_members where tenant_id=$1 order by lower(first_name), lower(last_name)`, [req.tenant.id]);
  res.json({ staff: r.rows });
}));
router.post("/staff", adminOnly, asyncHandler(async (req, res) => {
  const v = await validateStaffBody(req, { requireAll: true });
  const dup = await query(`select 1 from staff_members where lower(email)=lower($1)`, [v.email]);
  if (dup.rows.length) return res.status(409).json({ error: "That email address is already registered to a staff member." });
  const r = await query(`insert into staff_members (tenant_id, first_name, last_name, email) values ($1,$2,$3,$4) returning id, first_name, last_name, email, active, created_at`, [req.tenant.id, v.first, v.last, v.email]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `Staff user added: ${v.first} ${v.last}`]);
  res.json({ staff: r.rows[0] });
}));
router.patch("/staff/:id", adminOnly, asyncHandler(async (req, res) => {
  const v = await validateStaffBody(req, { requireAll: false });
  if (v.email) {
    const dup = await query(`select 1 from staff_members where lower(email)=lower($1) and id<>$2`, [v.email, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ error: "That email address is already registered to a staff member." });
  }
  const active = typeof req.body.active === "boolean" ? req.body.active : null;
  const r = await query(
    `update staff_members set first_name=coalesce($1,first_name), last_name=coalesce($2,last_name), email=coalesce($3,email), active=coalesce($6,active)
     where id=$4 and tenant_id=$5 returning id, first_name, last_name, email, active, created_at`,
    [v.first || null, v.last || null, v.email || null, req.params.id, req.tenant.id, active]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Staff member not found." });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id,
    active === null ? `Staff user updated: ${r.rows[0].first_name} ${r.rows[0].last_name}` : `Staff user ${active ? "enabled" : "disabled"}: ${r.rows[0].first_name} ${r.rows[0].last_name}`]);
  res.json({ staff: r.rows[0] });
}));
router.delete("/staff/:id", adminOnly, asyncHandler(async (req, res) => {
  const r = await query(`delete from staff_members where id=$1 and tenant_id=$2 returning first_name, last_name`, [req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Staff member not found." });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `Staff user removed: ${r.rows[0].first_name} ${r.rows[0].last_name}`]);
  res.json({ ok: true });
}));

// Self-service profile edit — business name, contact name, email, company address and
// website (website moved here from being per-location — it's a business-wide thing now).
router.patch("/me", adminOnly, asyncHandler(async (req, res) => {
  const businessName = optString(req.body.businessName, "Business name");
  // Older accounts may have no contact name; a blank one is simply left unchanged.
  const firstName = optString(req.body.firstName, "First name", { max: 100, allowEmpty: true }) || undefined;
  const lastName = optString(req.body.lastName, "Last name", { max: 100, allowEmpty: true }) || undefined;
  const email = optEmail(req.body.email);
  const companyAddress = optString(req.body.companyAddress, "Company address", { max: 500, allowEmpty: true });
  const websiteUrl = optString(req.body.websiteUrl, "Website", { max: 300, allowEmpty: true });
  // "How patients join" is account-wide. Validated strictly (undefined = leave unchanged).
  const channelMode = optEnum(req.body.channelMode, "channelMode", ["whatsapp", "web", "both"]);
  const whatsappUpdatesOffer = optBool(req.body.whatsappUpdatesOffer, "whatsappUpdatesOffer");
  const onsiteOnly = optBool(req.body.onsiteOnly, "onsiteOnly");
  const result = await query(
    `update tenants set
       business_name = coalesce($1, business_name),
       first_name = coalesce($2, first_name),
       last_name = coalesce($3, last_name),
       email = coalesce($4, email),
       company_address = coalesce($5, company_address),
       website_url = coalesce($6, website_url),
       channel_mode = coalesce($7, channel_mode),
       whatsapp_updates_offer = coalesce($8, whatsapp_updates_offer),
       onsite_only = coalesce($9, onsite_only)
     where id=$10 returning *`,
    [businessName, firstName, lastName, email, companyAddress, websiteUrl,
      channelMode ?? null, whatsappUpdatesOffer ?? null, onsiteOnly ?? null, req.tenant.id]
  );
  if (channelMode !== undefined || whatsappUpdatesOffer !== undefined || onsiteOnly !== undefined) {
    const r = result.rows[0];
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `Join settings changed (all locations): channel ${r.channel_mode}, WhatsApp updates ${r.whatsapp_updates_offer ? "offered" : "not offered"}, on-site only ${r.onsite_only ? "on" : "off"}`]);
  }
  res.json({ tenant: sanitizeTenant(result.rows[0], req.auth.role) });
}));

// Self-service account deletion — permanent, same as the system-admin "Delete customer"
// action: locations/services/licenses/audit log are all cascaded away, with an anonymised
// revenue snapshot kept (see lib/tenantDeletion.js). Admin-only — staff can't delete the account.
router.delete("/me", adminOnly, asyncHandler(async (req, res) => {
  await snapshotAndDeleteTenant(req.tenant.id);
  res.json({ ok: true });
}));

// Dashboard setup-progress checklist — lets a tenant permanently dismiss a nag they don't
// want to action (e.g. "add a website"), without it coming back.
router.post("/setup/dismiss", adminOnly, asyncHandler(async (req, res) => {
  const task = reqString(req.body.task, "Task", { max: 60 });
  const result = await query(
    `update tenants set dismissed_setup_tasks = array(select distinct unnest(dismissed_setup_tasks || $1::text[])) where id=$2 returning *`,
    [[task], req.tenant.id]
  );
  res.json({ tenant: sanitizeTenant(result.rows[0]) });
}));

// Self-service "pay now" — lets a pending (invoice/pay-later) account settle up itself instead
// of waiting on us to mark it paid. Card activates immediately (same "Stripe coming soon, no
// real charge yet" stand-in used at signup); invoice just records/updates the billing details
// and leaves the account pending for our team to confirm, same as the original invoice flow.
router.post("/pay-now", adminOnly, asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  const invoiceEmail = optString(req.body.invoiceEmail, "invoiceEmail", { max: 254, allowEmpty: true });
  const invoicePO = optString(req.body.invoicePO, "invoicePO", { max: 100, allowEmpty: true });
  if (req.tenant.status !== "pending") {
    return res.status(409).json({ error: "This account isn't waiting on a payment." });
  }
  if (paymentMethod === "card") {
    const result = await query(
      `update tenants set status='active', payment_method='card' where id=$1 returning *`,
      [req.tenant.id]
    );
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, "Card payment received — staff kiosk and customer WhatsApp are now enabled."]);
    return res.json({ tenant: sanitizeTenant(result.rows[0]) });
  }
  if (paymentMethod === "invoice") {
    if (!invoicePO?.trim()) return res.status(400).json({ error: "A PO / reference number is required for invoice payment." });
    const result = await query(
      `update tenants set payment_method='invoice', invoice_email=$1, invoice_po=$2 where id=$3 returning *`,
      [invoiceEmail || null, invoicePO.trim(), req.tenant.id]
    );
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, "Invoice details submitted — awaiting payment confirmation from our team."]);
    return res.json({ tenant: sanitizeTenant(result.rows[0]) });
  }
  res.status(400).json({ error: "Unknown payment method." });
}));

// --- Locations — free, unlimited; a routing + staff-access concept only -------------
router.get("/locations", asyncHandler(async (req, res) => {
  const result = await query(
    `select l.*, lc.code from locations l
     left join location_codes lc on lc.location_id = l.id
     where l.tenant_id=$1 order by l.archived asc, l.created_at`,
    [req.tenant.id]
  );
  res.json({ locations: result.rows });
}));

router.post("/locations", adminOnly, asyncHandler(async (req, res) => {
  const name = reqString(req.body.name, "Name");
  const address = optString(req.body.address, "Address", { max: 500, allowEmpty: true });
  const t = req.tenant;
  const staffAccessCode = genAccessCode();
  const loc = await query(
    `insert into locations (tenant_id, name, address, staff_access_code) values ($1,$2,$3,$4) returning *`,
    [t.id, name, address || "", staffAccessCode]
  );
  const code = await createLocationCode(query, req.tenant.id, loc.rows[0].id);
  await query(`update tenants set location_count = location_count + 1 where id=$1`, [req.tenant.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Location "${name}" added`]);
  res.json({ location: { ...loc.rows[0], code } });
}));

router.patch("/locations/:id", adminOnly, asyncHandler(async (req, res) => {
  // Website is business-wide now (see PATCH /me) — no longer edited per location.
  const name = optString(req.body.name, "Name");
  const address = optString(req.body.address, "Address", { max: 500, allowEmpty: true });
  const archived = optBool(req.body.archived, "archived");
  // Join settings (channel mode etc.) are account-wide now — see PATCH /me; any sent here are ignored.
  const result = await query(
    `update locations set name=coalesce($1,name), address=coalesce($2,address), archived=coalesce($3,archived)
     where id=$4 and tenant_id=$5 returning *`,
    [name, address, archived, req.params.id, req.tenant.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Location not found." });
  if (archived === true) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `Location "${result.rows[0].name}" archived`]);
  } else if (archived === false) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `Location "${result.rows[0].name}" unarchived`]);
  }
  res.json({ location: result.rows[0] });
}));

// Locations can no longer be permanently deleted from the customer-admin app — archive instead
// (see PATCH above) so a mistaken removal can't wipe out a location's services and license history.

// Every license this tenant has ever bought, across every service, with status freshly
// resolved — backs the Profile tab's licenses list (refund/print live there now instead of
// each service's own dropdown).
router.get("/licenses", adminOnly, asyncHandler(async (req, res) => {
  const services = (await query(`select id, name from services where tenant_id=$1`, [req.tenant.id])).rows;
  let licenses = [];
  for (const s of services) {
    const resolved = await resolveServiceLicenses(s.id);
    licenses = licenses.concat(resolved.map((l) => ({ ...l, service_name: s.name })));
  }
  licenses.sort((a, b) => new Date(b.purchased_at) - new Date(a.purchased_at));
  res.json({ licenses });
}));

// --- Services --------------------------------------------------------------------
// A service's location, name, mode and slot length are fixed the moment it's created
// (delete-and-recreate is the escape hatch) — staff access, customer routing and ticket
// history all depend on that staying put. Archiving just hides a service from the default
// list and from customers; it never touches its licenses.
router.get("/services", asyncHandler(async (req, res) => {
  const { includeArchived } = req.query;
  const result = await query(
    includeArchived === "true"
      ? `select * from services where tenant_id=$1 order by created_at`
      : `select * from services where tenant_id=$1 and archived=false order by created_at`,
    [req.tenant.id]
  );
  res.json({ services: result.rows });
}));

router.post("/services", adminOnly, asyncHandler(async (req, res) => {
  const { locationId } = req.body;
  if (locationId === undefined || locationId === null) throw badRequest("Name and location required.");
  const name = reqString(req.body.name, "Name");
  // The location must be one of this account's own.
  const ownLocation = isUuid(locationId)
    ? (await query(`select 1 from locations where id=$1 and tenant_id=$2`, [locationId, req.tenant.id])).rows[0]
    : null;
  if (!ownLocation) throw notFound("Location not found.");
  const result = await query(
    `insert into services (tenant_id, location_id, name) values ($1,$2,$3) returning *`,
    [req.tenant.id, locationId, name]
  );
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `Service "${name}" added`]);
  res.json({ service: result.rows[0] });
}));

const VALID_SLOT_MINUTES = [5, 10, 15, 30, 60];

router.patch("/services/:id", adminOnly, asyncHandler(async (req, res) => {
  const name = optString(req.body.name, "Name");
  const slotMinutes = optInt(req.body.slotMinutes, "slotMinutes", { min: 1, max: 1440, loose: true });
  const mode = optEnum(req.body.mode, "mode", ["queue", "appointment", "hybrid"]);
  const queuePaused = optBool(req.body.queuePaused, "queuePaused");
  const queueStaffCount = optInt(req.body.queueStaffCount, "queueStaffCount", { min: 0, max: 1000 });
  const archived = optBool(req.body.archived, "archived");
  if (slotMinutes !== undefined && !VALID_SLOT_MINUTES.includes(Number(slotMinutes))) {
    return res.status(400).json({ error: `Slot length must be one of: ${VALID_SLOT_MINUTES.join(", ")} minutes.` });
  }
  const existing = (await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Service not found." });
  const result = await query(
    `update services set
       name = coalesce($1, name),
       slot_minutes = coalesce($2, slot_minutes),
       mode = coalesce($3, mode),
       queue_paused = coalesce($4, queue_paused),
       queue_staff_count = coalesce($5, queue_staff_count),
       archived = coalesce($6, archived)
     where id=$7 and tenant_id=$8 returning *`,
    [name, slotMinutes, mode, queuePaused, queueStaffCount, archived, req.params.id, req.tenant.id]
  );
  if (typeof archived === "boolean" && archived !== existing.archived) {
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `Service "${existing.name}" ${archived ? "archived" : "unarchived"}`]);
  }
  res.json({ service: result.rows[0] });
}));

// Services can no longer be permanently deleted from customer-admin — archive instead
// (PATCH above with { archived: true }), same reasoning as locations: a mistaken delete
// would wipe out its license/revenue history for good.

// --- Service licenses --------------------------------------------------------------
// Lifecycle: Available (bought, bound to this service, no dates — movable to another
// service) -> Scheduled (dates assigned, locked to this service — movable only to other
// dates) -> Active (today falls within the window) -> Expired. Available licenses can also
// be Refunded, within 90 days of purchase. One license can ever cover a given calendar day
// on a service — never zero-or-more-than-one in an ambiguous way — so scheduling always
// checks for overlap against the service's own other scheduled/active licenses.
async function loadService(req, res, next) {
  const result = await query(`select * from services where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Service not found." });
  req.service = result.rows[0];
  next();
}

router.get("/services/:id/licenses", asyncHandler(loadService), asyncHandler(async (req, res) => {
  const licenses = await resolveServiceLicenses(req.service.id);
  res.json({ licenses });
}));

router.post("/services/:id/licenses", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { planId, customDays, paymentMethod } = req.body;
  const invoiceEmail = optString(req.body.invoiceEmail, "invoiceEmail", { max: 254, allowEmpty: true });
  const invoicePO = optString(req.body.invoicePO, "invoicePO", { max: 100, allowEmpty: true });
  const pricingRow = (await query(`select value from platform_settings where key='plan_prices'`)).rows[0];
  const plan = resolvePlan(planId, customDays, planPricing(pricingRow));
  if (!plan) return res.status(400).json({ error: "Unknown plan type." });

  // Card or invoice is chosen at the point of buying. Card is still the Stripe stand-in (no
  // card details are collected or stored here); invoice records the billing details.
  const method = ["invoice", "card", "later"].includes(paymentMethod) ? paymentMethod : (req.tenant.payment_method === "later" ? "card" : req.tenant.payment_method);
  if (method === "invoice" && Number(plan.price) > 0 && !invoicePO?.trim() && !req.tenant.invoice_po) {
    return res.status(400).json({ error: "A PO / reference number is required for invoice payment." });
  }
  const isFree = !(Number(plan.price) > 0);
  const licMethod = isFree ? null : method;
  const licPaid = isFree || method === "card";
  const result = await query(
    `insert into service_licenses (tenant_id, service_id, plan_id, plan_label, plan_days, price, status, payment_method, paid, paid_at, invoice_po)
     values ($1,$2,$3,$4,$5,$6,'available',$7,$8,$9,$10) returning *`,
    [req.tenant.id, req.service.id, plan.planId, plan.planLabel, plan.planDays, plan.price, licMethod, licPaid, licPaid && !isFree ? new Date() : null,
      method === "invoice" ? (invoicePO?.trim() || req.tenant.invoice_po || null) : null]
  );
  if (method === "invoice" && Number(plan.price) > 0) {
    await query(
      `update tenants set payment_method='invoice', invoice_email=coalesce($1, invoice_email), invoice_po=coalesce($2, invoice_po) where id=$3`,
      [invoiceEmail || null, invoicePO?.trim() || null, req.tenant.id]
    );
  } else if (method === "card" && req.tenant.payment_method !== "card") {
    await query(`update tenants set payment_method='card' where id=$1`, [req.tenant.id]);
  }
  const chargeNote = method === "invoice"
    ? `£${plan.price} added to next invoice`
    : method === "later" ? `£${plan.price} to pay later` : `£${plan.price} paid by card`;
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License bought for "${req.service.name}" — ${plan.planLabel}, ${chargeNote} (not yet scheduled)`]);
  res.json({ license: result.rows[0], charge: { amount: plan.price, note: chargeNote } });
}));

// Assign (or move) the calendar dates a license covers — one click on a start date, the
// end date is always derived from the plan's fixed length. Only Available/Scheduled
// licenses can be (re)scheduled; Active ones are locked.
router.patch("/services/:id/licenses/:licenseId", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const unschedule = optBool(req.body.unschedule, "unschedule");
  const startDate = unschedule ? undefined : optDate(req.body.startDate, "startDate");
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });

  if (unschedule) {
    if (license.status !== "scheduled") return res.status(409).json({ error: "Only a scheduled (not yet active) license can be unscheduled." });
    const result = await query(
      `update service_licenses set start_date=null, end_date=null, status='available', scheduled_at=null where id=$1 returning *`,
      [license.id]
    );
    // A "scheduled" license's whole window is still in the future (it flips to "active" the
    // moment start_date arrives), so it's safe to wipe any hours configured across it —
    // otherwise they'd silently reappear if this service is later rescheduled over the same
    // dates, with no sign anything had been cleared.
    await query(`delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
      [req.service.id, license.start_date, license.end_date]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
      [req.tenant.id, `License unscheduled for "${req.service.name}" — ${license.plan_label} (${license.start_date} to ${license.end_date}), hours cleared`]);
    return res.json({ license: result.rows[0] });
  }

  if (!startDate) return res.status(400).json({ error: "startDate required." });
  if (license.status !== "available" && license.status !== "scheduled") {
    return res.status(409).json({ error: "An active license's dates can't be changed." });
  }
  const endDate = computeEndDate(startDate, license.plan_days);
  const check = await checkSchedulable(req.service.id, startDate, endDate, license.id);
  if (!check.ok) return res.status(409).json({ error: check.error });

  const wasScheduled = license.status === "scheduled";
  const status = startDate <= getToday() ? "active" : "scheduled";

  // "Change dates" on an already-scheduled license moves it, it doesn't start fresh —
  // whatever hours/staffing were set on day N of the old window should land on day N
  // of the new window, same as the license itself just slid along the calendar. Do
  // the license update and the hours shift together so a failure partway through
  // can't leave the license pointing at dates whose hours didn't move with it.
  const client = await pool.connect();
  let result, hoursMoved = false;
  try {
    await client.query("BEGIN");
    result = await client.query(
      `update service_licenses set start_date=$1, end_date=$2, status=$3, scheduled_at=now() where id=$4 returning *`,
      [startDate, endDate, status, license.id]
    );
    if (wasScheduled && license.start_date && license.end_date) {
      const oldRows = (await client.query(
        `select date, hours, staff_count, booking_staff_count, walkin_staff_count from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
        [req.service.id, license.start_date, license.end_date]
      )).rows;
      if (oldRows.length) {
        const offsetDays = Math.round((new Date(startDate) - new Date(license.start_date)) / 86400000);
        // Clear whatever's left of the old window once its rows are moved off it (an
        // upsert below overwrites anything the new window overlapped, so this only
        // ever removes dates that are genuinely no longer covered by this license).
        await client.query(
          `delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3 and not (date >= $4 and date <= $5)`,
          [req.service.id, license.start_date, license.end_date, startDate, endDate]
        );
        for (const row of oldRows) {
          const newDate = addDays(row.date, offsetDays);
          await client.query(
            `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count, walkin_staff_count) values ($1,$2,$3,$4,$5,$6)
             on conflict (service_id, date) do update set
               hours = excluded.hours, staff_count = excluded.staff_count, booking_staff_count = excluded.booking_staff_count,
               walkin_staff_count = excluded.walkin_staff_count`,
            [req.service.id, newDate, row.hours, row.staff_count, row.booking_staff_count, row.walkin_staff_count]
          );
        }
        hoursMoved = true;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License ${wasScheduled ? "moved" : "scheduled"} for "${req.service.name}" — ${license.plan_label}, ${startDate} to ${endDate}${hoursMoved ? " (hours moved with it)" : ""}`]);
  res.json({ license: result.rows[0] });
}));

// Move an Available (never-scheduled) license to a different service. Once Scheduled or
// Active it's locked to its service for good.
router.post("/services/:id/licenses/:licenseId/move", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { targetServiceId } = req.body;
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });
  if (license.status !== "available") return res.status(409).json({ error: "Only an unscheduled license can be moved to another service." });
  const target = isUuid(targetServiceId)
    ? (await query(`select * from services where id=$1 and tenant_id=$2`, [targetServiceId, req.tenant.id])).rows[0]
    : null;
  if (!target) return res.status(404).json({ error: "Target service not found." });

  const result = await query(`update service_licenses set service_id=$1 where id=$2 returning *`, [target.id, license.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License moved from "${req.service.name}" to "${target.name}" — ${license.plan_label}`]);
  res.json({ license: result.rows[0] });
}));

// Refund stub — records the cancellation now; real money moves once Stripe is wired up.
// Available or Scheduled can both be refunded — neither has actually started yet. Once
// Active (today's inside its window) it's been live and can't be refunded from here.
// Settle a "pay later" license: by card (Stripe stand-in, nothing stored) or by invoice.
router.post("/services/:id/licenses/:licenseId/pay", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  const invoiceEmail = optString(req.body.invoiceEmail, "invoiceEmail", { max: 254, allowEmpty: true });
  const invoicePO = optString(req.body.invoicePO, "invoicePO", { max: 100, allowEmpty: true });
  const lic = (await query(`select * from service_licenses where id=$1 and service_id=$2 and tenant_id=$3`, [req.params.licenseId, req.service.id, req.tenant.id])).rows[0];
  if (!lic) return res.status(404).json({ error: "License not found." });
  if (lic.paid) return res.status(409).json({ error: "This license is already paid." });
  if (paymentMethod === "card") {
    const r = await query(`update service_licenses set payment_method='card', paid=true, paid_at=now() where id=$1 returning *`, [lic.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `${lic.plan_label} license for "${req.service.name}" paid by card`]);
    return res.json({ license: r.rows[0] });
  }
  if (paymentMethod === "invoice") {
    if (!invoicePO?.trim()) return res.status(400).json({ error: "A PO / reference number is required for invoice payment." });
    const r = await query(`update service_licenses set payment_method='invoice', invoice_po=$1 where id=$2 returning *`, [invoicePO.trim(), lic.id]);
    await query(`update tenants set invoice_email=coalesce($1, invoice_email), invoice_po=$2 where id=$3`, [invoiceEmail || null, invoicePO.trim(), req.tenant.id]);
    await query(`insert into audit_log (tenant_id, message) values ($1,$2)`, [req.tenant.id, `${lic.plan_label} license for "${req.service.name}" moved to invoice`]);
    return res.json({ license: r.rows[0] });
  }
  res.status(400).json({ error: "Unknown payment method." });
}));

router.post("/services/:id/licenses/:licenseId/refund", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const lateCheck = (await query(`select payment_method, paid from service_licenses where id=$1`, [req.params.licenseId])).rows[0];
  if (lateCheck && lateCheck.payment_method === "later" && lateCheck.paid === false) {
    return res.status(409).json({ error: "This license hasn't been paid for yet, so there's nothing to refund. Pay for it or choose invoice first." });
  }
  const license = await resolveServiceLicense(req.params.licenseId);
  if (!license || license.service_id !== req.service.id) return res.status(404).json({ error: "License not found." });
  if (license.status !== "available" && license.status !== "scheduled") {
    return res.status(409).json({ error: "Only a license that hasn't started yet (Available or Scheduled) can be refunded." });
  }
  if (!isWithinRefundWindow(license)) return res.status(409).json({ error: "This license was bought more than 3 months ago and can no longer be refunded." });

  if (license.status === "scheduled" && license.start_date && license.end_date) {
    await query(`delete from service_daily_config where service_id=$1 and date >= $2 and date <= $3`,
      [req.service.id, license.start_date, license.end_date]);
  }
  const result = await query(`update service_licenses set status='refunded', refunded_at=now() where id=$1 returning *`, [license.id]);
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `License refunded for "${req.service.name}" — ${license.plan_label}, £${license.price}`]);
  res.json({ license: result.rows[0] });
}));

// --- Per-day hours & staffing ----------------------------------------------------
router.get("/services/:id/daily-config", asyncHandler(loadService), asyncHandler(async (req, res) => {
  const from = reqDate(req.query.from, "from");
  const to = reqDate(req.query.to, "to");
  const result = await query(
    `select * from service_daily_config where service_id=$1 and date >= $2 and date <= $3 order by date`,
    [req.service.id, from, to]
  );
  const licenses = await resolveServiceLicenses(req.service.id);
  const windows = activeAndScheduledWindows(licenses);
  res.json({
    dailyConfig: result.rows,
    windows,
    lockedFrom: windows.length ? windows.map((w) => w.start).sort()[0] : null,
  });
}));

// A day is "live" once it is today or earlier (date <= getToday()). Past days are rejected
// outright. Today can still be edited: staff can always be increased, but only reduced while the
// service has no bookings and nobody in the queue today; hours that have already started (before
// nowMinutes) are frozen, and an hour block that already has non-cancelled tickets can't be removed.
function isLiveDate(date) {
  return !!date && String(date).slice(0, 10) <= String(getToday()).slice(0, 10);
}

const MAX_STAFF = 1000;

router.put("/services/:id/daily-config", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const { date } = req.body;
  const service = req.service;
  // A missing date can't be covered by any license; a malformed one is a bad request.
  if (date === undefined || date === null) {
    return res.status(409).json({ error: "That date isn't covered by a license for this service." });
  }
  reqDate(date, "date");
  const newHours = parseHours(req.body.hours);
  const staffCount = optInt(req.body.staffCount, "staffCount", { min: 0, max: MAX_STAFF });
  const bookingStaffCount = optInt(req.body.bookingStaffCount, "bookingStaffCount", { min: -MAX_STAFF, max: MAX_STAFF });
  const walkInStaffCount = optInt(req.body.walkInStaffCount, "walkInStaffCount", { min: -MAX_STAFF, max: MAX_STAFF });
  if (!(await isServiceLicensedOn(service.id, date))) {
    return res.status(409).json({ error: "That date isn't covered by a license for this service." });
  }
  if (isDateFullyPast(date)) return res.status(409).json({ error: "That date has already passed." });
  const resolvedStaff = staffCount ?? 2;
  const resolvedBooking = Math.max(0, Math.min(bookingStaffCount ?? 1, resolvedStaff));
  // walkInStaffCount is independently set now (not just "whoever's left over"), but it still
  // can't push the total past staffCount — clamp defensively here too, not just client-side.
  const requestedWalkIn = walkInStaffCount ?? Math.max(0, resolvedStaff - resolvedBooking);
  const resolvedWalkIn = Math.max(0, Math.min(requestedWalkIn, resolvedStaff - resolvedBooking));

  if (isLiveDate(date)) {
    const existing = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date])).rows[0];
    if (existing) {
      const reducing = resolvedStaff < existing.staff_count
        || resolvedBooking < (existing.booking_staff_count ?? 0)
        || resolvedWalkIn < (existing.walkin_staff_count ?? 0);
      if (reducing) {
        // Increases are always fine. A decrease (total, booking or walk-in staff) is only allowed
        // while nothing is committed against today's capacity: no non-cancelled bookings and nobody
        // waiting or being served in the queue for this service.
        const used = (await query(
          `select count(*)::int as n from tickets where service_id=$1 and visit_date=$2
             and ((type='booked' and status != 'cancelled') or (type='walk_in' and status in ('waiting','serving')))`,
          [service.id, date]
        )).rows[0].n;
        if (used > 0) {
          return res.status(409).json({ error: "Staff can't be reduced today because there are already bookings or customers in the queue for this service. You can still add more staff." });
        }
      }
      const nowMinutes = clockMinutesOrUndefined(req.body.nowMinutes) ?? londonNowMinutes();
      const oldHours = existing.hours || [];
      const removed = oldHours.filter((h) => !newHours.includes(h));
      const added = newHours.filter((h) => !oldHours.includes(h));
      if (removed.some((h) => h < nowMinutes) || added.some((h) => h < nowMinutes)) {
        return res.status(409).json({ error: "Hours that have already started can't be changed on a live day." });
      }
      if (removed.length) {
        const tix = (await query(
          `select type, slot_time, hour_block from tickets where service_id=$1 and visit_date=$2 and status != 'cancelled'`,
          [service.id, date]
        )).rows;
        const booked = removed.filter((h) => tix.some((t) => (t.type === "booked" ? t.slot_time >= h && t.slot_time < h + BLOCK_MINUTES : t.hour_block === h)));
        if (booked.length) {
          return res.status(409).json({ error: "Those hours already have bookings or people in the queue, so they can't be removed." });
        }
      }
    }
  }

  const result = await query(
    `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count, walkin_staff_count)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (service_id, date) do update set
       hours = excluded.hours, staff_count = excluded.staff_count, booking_staff_count = excluded.booking_staff_count,
       walkin_staff_count = excluded.walkin_staff_count
     returning *`,
    [service.id, date, newHours, resolvedStaff, resolvedBooking, resolvedWalkIn]
  );
  res.json({ dailyConfig: result.rows[0] });
}));

router.post("/services/:id/daily-config/copy", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const fromDate = reqDate(req.body.fromDate, "fromDate");
  const rawTo = req.body.toDates;
  if (rawTo !== undefined && rawTo !== null && (!Array.isArray(rawTo) || rawTo.length > 400)) throw badRequest("toDates must be a list of up to 400 dates.");
  const toDates = (rawTo || []).map((d) => reqDate(d, "toDates"));
  const sourceResult = await query(`select * from service_daily_config where service_id=$1 and date=$2`, [req.service.id, fromDate]);
  const source = sourceResult.rows[0] || { hours: [], staff_count: 2, booking_staff_count: 1, walkin_staff_count: 1 };
  const windows = activeAndScheduledWindows(await resolveServiceLicenses(req.service.id));
  let applied = 0;
  for (const date of toDates) {
    if (isLiveDate(date)) continue; // never overwrite a live (today/past) day in bulk
    if (!windows.some((w) => date >= w.start && date <= w.end)) continue;
    await query(
      `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count, walkin_staff_count)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (service_id, date) do update set
         hours = excluded.hours, staff_count = excluded.staff_count, booking_staff_count = excluded.booking_staff_count,
         walkin_staff_count = excluded.walkin_staff_count`,
      [req.service.id, date, source.hours, source.staff_count, source.booking_staff_count, source.walkin_staff_count]
    );
    applied++;
  }
  res.json({ ok: true, count: applied, skipped: toDates.length - applied });
}));

// Clears hours across every one of the service's scheduled/active windows in one call.
// Live days (today and earlier) are skipped entirely — only future days are cleared.
router.post("/services/:id/daily-config/clear-all", adminOnly, asyncHandler(loadService), asyncHandler(async (req, res) => {
  const licenses = await resolveServiceLicenses(req.service.id);
  const windows = activeAndScheduledWindows(licenses);
  if (!windows.length) return res.json({ ok: true, count: 0 });
  let applied = 0;
  for (const window of windows) {
    let d = window.start;
    let guard = 0;
    while (d <= window.end && guard < 400) {
      if (!isLiveDate(d)) { // live days (today/past) are never bulk-cleared
        const hours = [];
        await query(
          `insert into service_daily_config (service_id, date, hours, staff_count, booking_staff_count, walkin_staff_count)
           values ($1,$2,$3,2,1,1)
           on conflict (service_id, date) do update set hours = excluded.hours`,
          [req.service.id, d, hours]
        );
        applied++;
      }
      d = addDays(d, 1);
      guard++;
    }
  }
  res.json({ ok: true, count: applied });
}));

// --- Tickets ----------------------------------------------------------------------
const TICKET_STATUSES = ["waiting", "booked", "seen", "serving", "completed", "no_show", "cancelled"];

router.get("/tickets", asyncHandler(async (req, res) => {
  const date = optDate(req.query.date, "date") ?? getToday();
  await closeStaleTickets();
  const result = await query(
    `select * from tickets where tenant_id=$1 and visit_date=$2 order by created_at desc`,
    [req.tenant.id, date]
  );
  res.json({ tickets: result.rows });
}));

// Admin override: edits fields on a ticket. Fields left out are left alone (slotTime: null clears it).
router.patch("/tickets/:id", adminOnly, asyncHandler(async (req, res) => {
  const status = optEnum(req.body.status, "status", TICKET_STATUSES);
  const type = optEnum(req.body.type, "type", ["walk_in", "booked"]);
  const slotTimeGiven = req.body.slotTime !== undefined;
  const slotTime = optInt(req.body.slotTime, "slotTime", { min: 0, max: 1439 }) ?? null;
  const hourBlock = optInt(req.body.hourBlock, "hourBlock", { min: 0, max: 1410 });
  const { serviceId, locationId } = req.body;
  const existing = (await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!existing) throw notFound("Ticket not found.");

  let newServiceId = null, newLocationId = null;
  if (serviceId !== undefined && serviceId !== null) {
    const svc = isUuid(serviceId) ? (await query(`select id, location_id from services where id=$1 and tenant_id=$2`, [serviceId, req.tenant.id])).rows[0] : null;
    if (!svc) throw notFound("Service not found.");
    newServiceId = svc.id; newLocationId = svc.location_id;
  }
  if (locationId !== undefined && locationId !== null) {
    const loc = isUuid(locationId) ? (await query(`select id from locations where id=$1 and tenant_id=$2`, [locationId, req.tenant.id])).rows[0] : null;
    if (!loc) throw notFound("Location not found.");
    if (!newLocationId) newLocationId = loc.id; // a service move always takes that service's own location
  }
  const result = await query(
    `update tickets set
       status = coalesce($1, status),
       service_id = coalesce($2, service_id),
       location_id = coalesce($3, location_id),
       slot_time = case when $4::boolean then $5::int else slot_time end,
       type = coalesce($6, type),
       hour_block = coalesce($7, hour_block)
     where id=$8 and tenant_id=$9 returning *`,
    [status ?? null, newServiceId, newLocationId, slotTimeGiven, slotTime, type ?? null, hourBlock ?? null, existing.id, req.tenant.id]
  );
  res.json({ ticket: result.rows[0] });
}));

router.delete("/tickets/:id", adminOnly, asyncHandler(async (req, res) => {
  const r = await query(`delete from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id]);
  if (r.rowCount === 0) throw notFound("Ticket not found.");
  res.json({ ok: true });
}));

// The room a ticket is called to. Blank / non-text is a 400 with the same friendly message.
function parseRoom(v) {
  if (typeof v !== "string" || !v.trim()) throw badRequest("Set where you are (room name) before calling anyone.");
  return reqString(v, "Room name", { max: 80 });
}
// The client's clock, in minutes since midnight. Missing -> UK time now; present but nonsense -> 400.
function parseClock(v) {
  if (v === undefined || v === null) return londonNowMinutes();
  const n = clockMinutesOrUndefined(v);
  if (n === undefined) throw badRequest("clockMinutes must be a number of minutes between 0 and 1439.");
  return n;
}
const callMessage = (roomLabel) => `It's your turn! Please come to ${roomLabel}.`;

router.post("/services/:id/call-next", asyncHandler(async (req, res) => {
  const roomLabel = parseRoom(req.body.roomLabel);
  const date = reqDate(req.body.date, "date");
  const clockMinutes = parseClock(req.body.clockMinutes);
  // Hybrid services: staff choose to work the queue, the appointments, or both.
  const workType = optEnum(req.body.workType, "workType", ["queue", "appointments", "both"]);
  const takeWalkIns = workType !== "appointments";
  const takeBooked = workType !== "queue";
  // One atomic statement (row locked with FOR UPDATE SKIP LOCKED inside the subquery) so two
  // staff covering the same service calling "next" at the same moment can't both land on the
  // same ticket — the loser just sees the next one in line instead.
  const result = await query(
    `update tickets set status='serving', called_at=now(), finished_at=null, called_room=$7, called_by_staff_id=$8, called_by_name=$9
     where id = (
       select id from tickets
       where service_id=$1 and tenant_id=$2 and visit_date=$3
         and (($5 and type='walk_in' and status='waiting') or ($6 and type='booked' and status='booked' and slot_time <= $4))
       order by (case when type='booked' then slot_time else extract(epoch from created_at)::int end) asc
       limit 1
       for update skip locked
     )
     returning *`,
    [req.params.id, req.tenant.id, date, clockMinutes, takeWalkIns, takeBooked, roomLabel, req.staff?.id || null, staffName(req)]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Nobody left to call." });
  const ticket = result.rows[0];
  const roomText = `Please come to ${roomLabel}.`;
  const body = callMessage(roomLabel);
  await logSimulatedMessage({ tenantId: req.tenant.id, channel: "whatsapp", toReference: ticket.ticket_number, body });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} called forward — WhatsApp ping sent: "${roomText}"`]);
  res.json({ ticket: { ...ticket, status: "serving" }, message: body });
}));

// Call one specific ticket out of turn (e.g. someone urgent, or a booked patient who's arrived
// early). Same atomic claim as call-next: only a ticket that's still waiting/booked can be taken,
// so two staff clicking the same row can't both call it.
router.post("/tickets/:id/call", asyncHandler(async (req, res) => {
  const roomLabel = parseRoom(req.body.roomLabel);
  const result = await query(
    `update tickets set status='serving', called_at=now(), finished_at=null, called_room=$3, called_by_staff_id=$4, called_by_name=$5 where id=$1 and tenant_id=$2 and status in ('waiting','booked') returning *`,
    [req.params.id, req.tenant.id, roomLabel, req.staff?.id || null, staffName(req)]
  );
  if (result.rows.length === 0) return res.status(409).json({ error: "That ticket has already been called or is no longer waiting." });
  const ticket = result.rows[0];
  const roomText = `Please come to ${roomLabel}.`;
  const body = callMessage(roomLabel);
  await logSimulatedMessage({ tenantId: req.tenant.id, channel: "whatsapp", toReference: ticket.ticket_number, body });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} called forward out of turn — WhatsApp ping sent: "${roomText}"`]);
  res.json({ ticket, message: body });
}));

// The single-ticket actions below all start from this: the ticket must exist in this account (404),
// and can then only be moved on from the states the action makes sense for (409 otherwise).
async function loadOwnTicket(req) {
  const ticket = (await query(`select * from tickets where id=$1 and tenant_id=$2`, [req.params.id, req.tenant.id])).rows[0];
  if (!ticket) throw notFound("Ticket not found.");
  return ticket;
}
const serviceName = async (id) => (await query(`select name from services where id=$1`, [id])).rows[0]?.name;

router.post("/tickets/:id/call-again", asyncHandler(async (req, res) => {
  const roomLabel = parseRoom(req.body.roomLabel);
  const ticket = await loadOwnTicket(req);
  if (ticket.status !== "serving") throw conflict("Only a ticket that has been called can be called again.");
  const roomText = `Please come to ${roomLabel}.`;
  const body = callMessage(roomLabel);
  await logSimulatedMessage({ tenantId: req.tenant.id, channel: "whatsapp", toReference: ticket.ticket_number, body });
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} called again — WhatsApp ping sent: "${roomText}"`]);
  res.json({ ok: true, message: body });
}));

router.post("/tickets/:id/return-to-queue", asyncHandler(async (req, res) => {
  const clockMinutes = parseClock(req.body.clockMinutes);
  const ticket = await loadOwnTicket(req);
  if (ticket.status !== "serving") throw conflict("Only a ticket that has been called can be returned to the queue.");
  const service = (await query(`select * from services where id=$1`, [ticket.service_id])).rows[0];
  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [ticket.service_id, ticket.visit_date])).rows[0];
  let hourBlock = ticket.hour_block;
  if (day?.hours?.length) {
    const cfg = { hours: day.hours, slotMinutes: service.slot_minutes, staffCount: day.staff_count, bookingStaffCount: day.booking_staff_count };
    hourBlock = currentHourBlock(cfg, clockMinutes);
  }
  const result = await query(
    `update tickets set status='waiting', type='walk_in', slot_time=null, hour_block=$1, called_at=null, finished_at=null where id=$2 and status='serving' returning *`,
    [hourBlock, ticket.id]
  );
  if (!result.rows[0]) throw conflict("That ticket is no longer being served.");
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} didn't come forward — returned to the ${service?.name || "service"} queue`]);
  res.json({ ticket: result.rows[0] });
}));

router.post("/tickets/:id/cancel", asyncHandler(async (req, res) => {
  const ticket = await loadOwnTicket(req);
  const r = await query(`update tickets set status='cancelled' where id=$1 and tenant_id=$2 and status in ('waiting','booked','serving') returning *`, [ticket.id, req.tenant.id]);
  if (!r.rows[0]) throw conflict("This ticket has already ended, so it can't be cancelled.");
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} cancelled — didn't come forward for ${(await serviceName(ticket.service_id)) || "service"}`]);
  res.json({ ticket: r.rows[0] });
}));

// Distinct from "cancel" — this is for when staff called the customer forward and they never
// showed, which matters separately in reporting (dashboard/stats already tracks no_show).
router.post("/tickets/:id/no-show", asyncHandler(async (req, res) => {
  const ticket = await loadOwnTicket(req);
  const r = await query(`update tickets set status='no_show' where id=$1 and tenant_id=$2 and status in ('waiting','booked','serving') returning *`, [ticket.id, req.tenant.id]);
  if (!r.rows[0]) throw conflict("This ticket has already ended, so it can't be marked as a no-show.");
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} marked as no-show for ${(await serviceName(ticket.service_id)) || "service"}`]);
  res.json({ ticket: r.rows[0] });
}));

router.post("/tickets/:id/route", asyncHandler(async (req, res) => {
  const { newServiceId } = req.body;
  const clockMinutes = parseClock(req.body.clockMinutes);
  const ticket = await loadOwnTicket(req);
  const oldService = (await query(`select name from services where id=$1`, [ticket.service_id])).rows[0];
  const newService = isUuid(newServiceId)
    ? (await query(`select * from services where id=$1 and tenant_id=$2`, [newServiceId, req.tenant.id])).rows[0]
    : null;
  if (!newService) return res.status(404).json({ error: "Target service not found." });
  if (!["waiting", "booked", "serving"].includes(ticket.status)) throw conflict("This ticket has already ended, so it can't be sent to another service.");

  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [newService.id, ticket.visit_date])).rows[0];
  let hourBlock = null;
  if (day?.hours?.length) {
    const cfg = { hours: day.hours, slotMinutes: newService.slot_minutes, staffCount: day.staff_count, bookingStaffCount: day.booking_staff_count };
    hourBlock = currentHourBlock(cfg, clockMinutes);
  }
  const result = await query(
    `update tickets set service_id=$1, location_id=$2, status='waiting', type='walk_in', slot_time=null, hour_block=$3, called_at=null, finished_at=null
     where id=$4 and status in ('waiting','booked','serving') returning *`,
    [newService.id, newService.location_id, hourBlock, ticket.id]
  );
  if (!result.rows[0]) throw conflict("This ticket has already ended, so it can't be sent to another service.");
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} routed from ${oldService?.name || "service"} to ${newService.name}`]);
  res.json({ ticket: result.rows[0] });
}));

router.post("/tickets/:id/close", asyncHandler(async (req, res) => {
  const ticket = await loadOwnTicket(req);
  if (ticket.status === "completed") return res.json({ ok: true }); // repeating a close is harmless
  const r = await query(`update tickets set status='completed', finished_at=coalesce(finished_at, now()) where id=$1 and status='serving' returning id`, [ticket.id]);
  if (!r.rows[0]) throw conflict("Only a ticket that has been called can be closed.");
  await query(`insert into audit_log (tenant_id, message) values ($1,$2)`,
    [req.tenant.id, `Ticket ${ticket.ticket_number} closed — finished serving for ${(await serviceName(ticket.service_id)) || "service"}`]);
  res.json({ ok: true });
}));

// --- Today (day ribbon) -----------------------------------------------------------
// Read-only snapshot of today for one service: per 30-minute block the staff on, booking and
// walk-in capacity and how much is used. Open to staff as well as admins. The client may pass
// clockMinutes (its local time, like the other routes); otherwise London time is used.
router.get("/today", asyncHandler(async (req, res) => {
  const { serviceId } = req.query;
  if (!serviceId) return res.status(400).json({ error: "serviceId required." });
  const service = isUuid(serviceId) ? (await query(`select * from services where id=$1 and tenant_id=$2`, [serviceId, req.tenant.id])).rows[0] : null;
  if (!service) return res.status(404).json({ error: "Service not found." });

  const date = getToday();
  const nowMinutes = clockMinutesOrUndefined(req.query.clockMinutes) ?? londonNowMinutes();
  const empty = (reason) => res.json({
    date, serviceId: service.id, serviceName: service.name, mode: service.mode, open: false, reason,
    blocks: [], nowMinutes, queueCount: 0, staffNow: 0, totals: { freeLeft: 0, bookedTotal: 0 },
  });

  if (service.archived || !(await isServiceLicensedOn(service.id, date))) return empty("outside_license_window");
  const day = (await query(`select * from service_daily_config where service_id=$1 and date=$2`, [service.id, date])).rows[0];
  if (!day || !day.hours?.length) return empty("closed");

  // Same mode mapping and defaults as /services/:id/availability.
  const cfg = dayCfg(service, day);

  const tix = (await query(
    `select type, status, slot_time, hour_block from tickets
     where tenant_id=$1 and service_id=$2 and visit_date=$3 and status != 'cancelled'`,
    [req.tenant.id, service.id, date]
  )).rows;
  res.json({
    date, serviceId: service.id, serviceName: service.name, mode: service.mode, open: true, reason: null,
    slotMinutes: service.slot_minutes, ...buildTodayRibbon(cfg, tix, nowMinutes),
  });
}));

// --- Availability (used by the Customer WhatsApp simulator) -----------------------
router.get("/services/:id/availability", asyncHandler(async (req, res) => {
  const service = await loadServiceForTenant(req.tenant.id, req.params.id);
  if (!service) return res.status(404).json({ error: "Service not found." });
  res.json(await getAvailability(service, req.query.date, req.query.clockMinutes));
}));

router.post("/services/:id/tickets", asyncHandler(async (req, res) => {
  const parsed = parseTicketRequest(req.body);
  const service = await loadServiceForTenant(req.tenant.id, req.params.id);
  if (!service) return res.status(404).json({ error: "Service not found." });
  const { ticket } = await createTicket({ tenantId: req.tenant.id, service, req: parsed });
  res.json({ ticket });
}));

// --- Audit log & dashboard ---------------------------------------------------------
router.get("/audit-log", asyncHandler(async (req, res) => {
  const result = await query(`select * from audit_log where tenant_id=$1 order by created_at desc limit 200`, [req.tenant.id]);
  res.json({ auditLog: result.rows });
}));

router.get("/dashboard/stats", asyncHandler(async (req, res) => {
  const date = optDate(req.query.date, "date") ?? getToday();
  const result = await query(
    `select status, count(*) from tickets where tenant_id=$1 and visit_date=$2 group by status`,
    [req.tenant.id, date]
  );
  const stats = { waiting: 0, booked: 0, serving: 0, completed: 0, no_show: 0, cancelled: 0 };
  result.rows.forEach((r) => { stats[r.status] = Number(r.count); });
  res.json({ stats });
}));

export default router;
