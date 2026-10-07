import { useState, useEffect, useRef } from "react";
import { priceText, exMoney, incVat, VAT_RATE } from "./lib/vat.js";
import { api, setToken, hasToken } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";
import TodayPanel from "./TodayPanel.jsx";

// --- Date & time helpers -----------------------------------------------------
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatTime(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}
function isDateLockedClient(dateStr) {
  return dateStr <= todayIso();
}

// Small "copy to clipboard" button — used anywhere a sign-in code is shown so staff don't
// have to retype it. Shows a brief "Copied" confirmation instead of a silent no-op.
// Two-rectangles "copy" glyph, swapped for a checkmark briefly after a successful copy —
// drawn rather than a text/emoji label so it reads as a small, unobtrusive action icon.
function CopyIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CopyButton({ value, label = "Copy", showText = false }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      className={showText ? "btn-outline" : "btn-outline icon-btn"}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}{showText && (copied ? "Copied" : "Copy")}
    </button>
  );
}
// A plain archive-box icon (lid + box) — clearer at a glance than a generic emoji, and
// renders consistently across platforms since it's drawn, not a font glyph.
function ArchiveIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="16" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 7.5V15a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 10.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function ChevronRight({ size = 20 }) {
  return (
    <svg className="chev" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
  );
}
function BackIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
  );
}
function QrIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
      <path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 18h3v3h-3z" />
    </svg>
  );
}
function DotsIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
  );
}
// Navigation glyphs, drawn so they render the same everywhere.
const NAV_PATHS = {
  dashboard: <path d="M4 11l8-7 8 7v9H4z" />,
  locations: <><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  staff: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5a3.5 3.5 0 010 7M18 14c2 .6 3.5 2.4 3.5 6" /></>,
  profile: <><rect x="4" y="3" width="16" height="18" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  audit: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>,
  shop: <><path d="M4 8h16l-1.5 12h-13z" /><path d="M9 8V6a3 3 0 016 0v2" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  signout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" /></>,
};
function NavIcon({ name }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{NAV_PATHS[name]}</svg>
  );
}

// A small "More" (three-dots) popover menu. items: [{ label, onClick, danger }]. Closes on
// outside click, Escape, or choosing an item; items are 44px tall so they're easy to tap.
function MoreMenu({ items, label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <span className="menu-wrap" ref={ref}>
      <button type="button" className="btn-outline icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <DotsIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function isDatePastClient(dateStr) {
  return dateStr < todayIso();
}
function addDaysIso(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
function addMonthsIso(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00Z");
  const nd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
  return nd.toISOString().slice(0, 10);
}
function daysInMonthOf(firstOfMonthStr) {
  const d = new Date(firstOfMonthStr + "T00:00:00Z");
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return next.getUTCDate();
}
function weekdayIndex(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
}
function monthLabel(firstOfMonthStr) {
  const d = new Date(firstOfMonthStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
// Every other on-screen date goes through here instead of the raw "YYYY-MM-DD" value —
// uses the browser's own locale (no hardcoded format), so it reads dd/mm/yyyy for a UK
// browser and whatever's locally correct everywhere else, instead of the ambiguous
// numeric ISO string.
function formatDateDisplay(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}
function buildCalendarWeeks(firstOfMonthStr) {
  const total = daysInMonthOf(firstOfMonthStr);
  const leading = weekdayIndex(firstOfMonthStr);
  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 0; d < total; d++) cells.push(addDaysIso(firstOfMonthStr, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const GRID_HOURS = [];
for (let h = 7 * 60; h < 20 * 60; h += 30) GRID_HOURS.push(h);
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

// Shared logo mark — a steel-blue tile with an amber "notch", plus the wordmark.
function Logo({ size = 24, dark = false }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
        <rect x="2" y="2" width="40" height="40" fill="var(--accent)" />
        <circle cx="42" cy="22" r="7" fill="var(--blue)" />
      </svg>
      <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState("admin-login");
  const [tenant, setTenant] = useState(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    async function restore() {
      await refreshClock();
      if (hasToken("tenant_admin")) {
        try {
          const r = await api.me();
          setTenant(r.tenant);
          setScreen("admin");
        } catch {
          setToken("tenant_admin", null); // stored token was invalid/expired
        }
      }
      setRestoring(false);
    }
    restore();
  }, []);

  if (restoring) return <div className="container muted" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  function doSignOut() {
    setToken("tenant_admin", null);
    setTenant(null);
    setScreen("admin-login");
  }

  return (
    <div>
      {tenant && screen === "admin" ? (
        <div className="app-header is-admin">
          <div className="grow">
            <div className="eyebrow">Customer admin</div>
            <div className="name">{tenant.business_name}</div>
          </div>
          {isSimulatedToday() && <span className="badge badge-amber">Simulated: {formatDateDisplay(todayIso())}</span>}
          <span className="status">{tenant.status === "pending" ? "Payment pending" : "Active"}</span>
        </div>
      ) : (
        <div className="header row" style={{ justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 10 }}>
            <Logo />
          </div>
          <div className="row">
            {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {formatDateDisplay(todayIso())}</span>}
            <a href={import.meta.env.VITE_MARKETING_URL || "http://localhost:5175"} style={{ color: "var(--brand)", fontSize: 14, fontWeight: 600, minHeight: 44, display: "inline-flex", alignItems: "center" }}>New here? Sign up →</a>
          </div>
        </div>
      )}
      {error && <div className="container" role="alert"><div className="card row wrap" style={{ borderColor: "#B3261E", color: "#B3261E" }}><span className="grow">{error}</span><button className="btn-outline" onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "admin-login" && <AdminLogin onSignedIn={(t) => { setTenant(t); setScreen("admin"); }} setError={setError} />}
      {screen === "admin" && tenant && <AdminDashboard tenant={tenant} onTenantChange={setTenant} onAccountDeleted={doSignOut} onSignOut={doSignOut} setError={setError} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AdminLogin({ onSignedIn, setError }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [demoOtp, setDemoOtp] = useState(null);

  async function sendCode() {
    setError("");
    try {
      const r = await api.requestAdminOtp(email);
      setDemoOtp(r.demoOtp);
      setStep("otp");
    } catch (err) { setError(err.message); }
  }
  async function verify() {
    setError("");
    try {
      const r = await api.verifyAdminOtp(email, code);
      setToken("tenant_admin", r.token);
      onSignedIn(r.tenant);
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="narrow">
      <div className="card stack">
        <h1 style={{ fontSize: 22 }}>Admin sign-in</h1>
        {step === "email" && (
          <>
            <label className="field">
              <span className="field-label">Email address</span>
              <input className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="btn" onClick={sendCode}>Send login code</button>
          </>
        )}
        {step === "otp" && (
          <>
            <div className="muted">We've emailed a code (demo: <strong>{demoOtp}</strong>)</div>
            <label className="field">
              <span className="field-label">6-digit code</span>
              <input className="input mono" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="btn" onClick={verify}>Verify &amp; sign in</button>
          </>
        )}
      </div>
    </div>
  );
}

function PendingPaymentBanner({ tenant }) {
  if (tenant.status !== "pending") return null;
  return (
    <div className="card" style={{ background: "#FBE9E7", borderColor: "#B3261E", color: "#B3261E", fontSize: 13, fontWeight: 500 }}>
      Payment pending — your account can be configured now, but staff kiosk and customer WhatsApp won't work until payment is received.
    </div>
  );
}

const TAB_TITLES = { dashboard: "Dashboard", locations: "Locations", staff: "Staff", profile: "Account", audit: "Audit log", shop: "Shop" };
const SIDE_TABS = ["dashboard", "locations", "staff", "profile", "audit", "shop"];
const PHONE_TABS = ["dashboard", "locations", "staff", "profile"];

function AdminDashboard({ tenant, onTenantChange, onAccountDeleted, onSignOut, setError }) {
  const [tab, setTab] = useState("dashboard");
  const [moreOpen, setMoreOpen] = useState(false);
  const [openLocId, setOpenLocId] = useState(undefined); // undefined = default (auto-open a sole location), null = list, id = that location
  const [ticketFilter, setTicketFilter] = useState("all");
  const [renewServiceId, setRenewServiceId] = useState(null);
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [addingServiceFor, setAddingServiceFor] = useState(null);
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const [allLicenses, setAllLicenses] = useState([]);
  const date = todayIso();
  const STAFF_APP_URL = import.meta.env.VITE_STAFF_APP_URL || "http://localhost:5176";
  const CUSTOMER_APP_URL = import.meta.env.VITE_CUSTOMER_APP_URL || "http://localhost:5177";
  const customerLink = `${CUSTOMER_APP_URL}/?t=${tenant.id}`;

  async function refreshCore() {
    try {
      const [locRes, svcRes] = await Promise.all([api.getLocations(), api.getServices(true)]);
      setLocations(locRes.locations); setServices(svcRes.services);
    } catch (err) { setError(err.message); }
  }
  const visibleServices = services.filter((s) => !s.archived);
  const archivedServices = services.filter((s) => s.archived);
  const visibleLocations = locations.filter((l) => !l.archived);
  // Services offered in the Today panel: active ones at active locations, first service is the default.
  const todayServices = visibleServices
    .filter((sv) => visibleLocations.some((l) => l.id === sv.location_id))
    .map((sv) => ({ id: sv.id, name: sv.name, locationName: visibleLocations.length > 1 ? visibleLocations.find((l) => l.id === sv.location_id)?.name : undefined }));
  const archivedLocations = locations.filter((l) => l.archived);
  async function refreshQueue() {
    try {
      const [tixRes, statsRes] = await Promise.all([api.getTickets(date), api.getDashboardStats(date)]);
      setTickets(tixRes.tickets);
      setStats(statsRes.stats);
    } catch (err) { setError(err.message); }
  }
  async function refreshAudit() {
    try { const logRes = await api.getAuditLog(); setAuditLog(logRes.auditLog); } catch (err) { setError(err.message); }
  }
  async function refreshLicenses() {
    try { const r = await api.getAllLicenses(); setAllLicenses(r.licenses); } catch (err) { setError(err.message); }
  }
  useEffect(() => { refreshCore(); refreshQueue(); refreshAudit(); refreshLicenses(); }, []);

  const hasLicense = allLicenses.some((l) => l.status !== "refunded");
  const unscheduledLicenseCount = allLicenses.filter((l) => l.status === "available").length;
  const hasAddress = !!(tenant.company_address && tenant.company_address.trim());
  const hasWebsite = !!(tenant.website_url && tenant.website_url.trim());
  const dismissedSetupTasks = tenant.dismissed_setup_tasks || [];
  const allSetupTasks = [
    { key: "payment", label: "Complete payment to activate your account", done: tenant.status !== "pending", cta: "Pay now", go: () => setTab("profile") },
    { key: "license", label: "Buy a license for a service", done: hasLicense, cta: "Go to Locations", go: () => setTab("locations") },
    {
      key: "schedule",
      label: unscheduledLicenseCount > 1 ? `Schedule your ${unscheduledLicenseCount} purchased licenses` : "Schedule your purchased license",
      done: unscheduledLicenseCount === 0,
      cta: "Go to Locations", go: () => setTab("locations"),
    },
    { key: "address", label: "Enter your business address", done: hasAddress, cta: "Go to Profile", go: () => setTab("profile") },
    { key: "website", label: "Add your business website", done: hasWebsite, cta: "Go to Profile", go: () => setTab("profile") },
  ];
  const setupTasks = allSetupTasks.filter((t) => !dismissedSetupTasks.includes(t.key));
  const setupDone = setupTasks.filter((t) => t.done).length;
  const setupPercent = setupTasks.length === 0 ? 100 : Math.round((setupDone / setupTasks.length) * 100);
  async function dismissSetupTask(key) {
    try {
      const r = await api.dismissSetupTask(key);
      onTenantChange?.(r.tenant);
    } catch (err) { setError(err.message); }
  }

  // Light polling for near-real-time (not a WebSocket/Supabase-realtime subscription — just periodic refetch).
  useEffect(() => {
    const id = setInterval(() => { refreshQueue(); }, 10000);
    return () => clearInterval(id);
  }, []);

  function goTab(t) {
    setTab(t);
    setMoreOpen(false);
    if (t === "dashboard") refreshQueue();
    if (t === "audit") refreshAudit();
    if (t === "profile") refreshLicenses();
    if (t === "locations" && tab === "locations") setOpenLocId(null); // tapping the active tab again returns to the list
  }
  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e) { if (e.key === "Escape") setMoreOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);
  // Licences ending today with nothing queued up behind them — a nudge to renew.
  const endingToday = allLicenses.filter((l) => {
    if (l.status !== "active" || l.end_date !== date) return false;
    const svc = services.find((s) => s.id === l.service_id);
    if (!svc || svc.archived) return false;
    const tomorrow = addDaysIso(date, 1);
    return !allLicenses.some((o) => o.id !== l.id && o.service_id === l.service_id && o.status === "scheduled" && o.start_date && o.start_date <= tomorrow);
  }).filter((l, i, arr) => arr.findIndex((o) => o.service_id === l.service_id) === i);
  function renewService(serviceId) {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    setTab("locations");
    setOpenLocId(svc.location_id);
    setRenewServiceId(serviceId);
  }
  const filteredTickets = ticketFilter === "all" ? tickets : tickets.filter((t) => t.status === ticketFilter);
  function ticketBadge(t) {
    if (t.status === "completed") return { cls: "badge-grey", text: "Completed" };
    if (t.status === "serving") return { cls: "badge-blue", text: "Serving" };
    if (t.status === "waiting") return { cls: "badge-amber", text: "Waiting" };
    if (t.status === "cancelled") return { cls: "badge-red", text: "Cancelled" };
    if (t.status === "no_show") return { cls: "badge-red", text: "No-show" };
    if (t.status === "booked") return t.arrived_at ? { cls: "badge-green", text: "Checked in" } : { cls: "badge-line", text: "Booked" };
    return { cls: "badge-blue", text: t.status };
  }
  function moveSelect(t) {
    return (
      <select
        aria-label={`Move ticket ${t.ticket_number} to another service`}
        value=""
        onChange={async (e) => { if (e.target.value) { await api.updateTicket(t.id, { serviceId: e.target.value }); refreshQueue(); } }}
      >
        <option value="">Move to…</option>
        {services.filter((s) => s.id !== t.service_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  }
  async function deleteTicket(t) { await api.deleteTicket(t.id); refreshQueue(); }
  const effectiveOpenLocId = openLocId !== undefined ? openLocId : (visibleLocations.length === 1 ? visibleLocations[0].id : null);
  const openLoc = tab === "locations" && effectiveOpenLocId ? visibleLocations.find((l) => l.id === effectiveOpenLocId) || null : null;
  const moreActive = tab === "audit" || tab === "shop";

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <div className="side-brand">
          <div className="eyebrow">Customer admin</div>
          <div className="name">{tenant.business_name}</div>
          <div style={{ fontSize: 12, color: "#B9C7D3", marginTop: 4 }}>{tenant.status === "pending" ? "Payment pending" : "Active"}</div>
          {isSimulatedToday() && <div className="badge badge-amber" style={{ marginTop: 8 }}>Simulated: {formatDateDisplay(todayIso())}</div>}
        </div>
        <nav aria-label="Main">
          {SIDE_TABS.map((t) => (
            <button key={t} type="button" className={`side-link${tab === t ? " active" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => goTab(t)}>
              <NavIcon name={t} />{TAB_TITLES[t]}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button type="button" className="side-link" onClick={onSignOut}><NavIcon name="signout" />Sign out</button>
      </aside>

      <main className="shell-main stack" style={{ gap: 16 }}>
        <div className="page-head">
          {openLoc ? (
            <div className="loc-top grow">
              <div className="subhead">
                <button type="button" className="back-btn" aria-label="Back to locations" onClick={() => { setOpenLocId(null); setAddingServiceFor(null); }}><BackIcon /></button>
                <LocationNameField key={openLoc.id} loc={openLoc} onSaved={refreshCore} setError={setError} />
              </div>
              <LocationStatusLine services={visibleServices.filter((s) => s.location_id === openLoc.id)} allLicenses={allLicenses} today={date} />
            </div>
          ) : (
            <h1>{TAB_TITLES[tab]}</h1>
          )}
          {tab === "locations" && !openLoc && !addingLocation && (
            <button type="button" className="btn add-loc-btn" onClick={() => setAddingLocation(true)}>+ Add location</button>
          )}
        </div>

      {tab === "locations" && (
        <div className="stack" style={{ gap: 16 }}>
          <PendingPaymentBanner tenant={tenant} />

          {addingLocation && !openLoc && (
            <div className="card stack">
              <label className="field">
                <span className="field-label">Location name</span>
                <input className="input" autoFocus value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
              </label>
              <div className="form-actions">
                <button className="btn" disabled={!newLocationName.trim()} onClick={async () => { try { await api.addLocation(newLocationName.trim()); setNewLocationName(""); setAddingLocation(false); refreshCore(); } catch (err) { setError(err.message); } }}>Add</button>
                <button className="btn-outline" onClick={() => { setAddingLocation(false); setNewLocationName(""); }}>Cancel</button>
              </div>
            </div>
          )}

          {!openLoc && visibleLocations.length === 0 && !addingLocation && (
            <div className="card muted">No locations yet — add your first location to get started.</div>
          )}

          {!openLoc && visibleLocations.length > 0 && (
            <div className="loc-grid">
              {visibleLocations.map((loc) => {
                const locServices = visibleServices.filter((s) => s.location_id === loc.id);
                return (
                  <div key={loc.id} className="loc-card">
                    <button type="button" className="loc-open" onClick={() => setOpenLocId(loc.id)} aria-label={`Open ${loc.name}`}>
                      <span className="grow">
                        <span className="loc-name" style={{ display: "block" }}>{loc.name}</span>
                        <span className="muted small" style={{ display: "block" }}>{locServices.length} service{locServices.length === 1 ? "" : "s"} · {locationLicenceText(locServices, allLicenses, date)}</span>
                      </span>
                      <ChevronRight />
                    </button>
                    {loc.code && (
                      <div className="code-row">
                        <span className="label">WhatsApp code</span>
                        <span className="code-text">{loc.code}</span>
                        <CopyButton value={loc.code} label={`Copy code for ${loc.name}`} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {openLoc && (() => {
            const loc = openLoc;
            const locServices = visibleServices.filter((s) => s.location_id === loc.id);
            const addingHere = addingServiceFor === loc.id;
            return (
              <div className="stack" style={{ gap: 16 }}>
                <div className="loc-toolbar" role="toolbar" aria-label={`${loc.name} actions`}>
                  {loc.code && (
                    <span className="loc-code" title="Customers message this code on WhatsApp">
                      <span className="label">WhatsApp code</span>
                      <span className="code-text">{loc.code}</span>
                      <CopyButton value={loc.code} label="Copy code" />
                    </span>
                  )}
                  {!addingHere && <button className="btn-outline" onClick={() => setAddingServiceFor(loc.id)}>+ Add service</button>}
                  <button
                    type="button"
                    className="btn-outline icon-btn"
                    aria-label="Archive location"
                    title="Archive location"
                    onClick={async () => {
                      if (confirm(`Archive "${loc.name}"? It'll move to the Audit tab, and you can unarchive it from there any time. Its services and license history are kept.`)) {
                        await api.archiveLocation(loc.id);
                        setOpenLocId(null);
                        refreshCore();
                      }
                    }}
                  >
                    <ArchiveIcon size={20} />
                  </button>
                </div>

                <ChannelSettings key={loc.id} loc={loc} tenant={tenant} onSaved={refreshCore} />

                {addingHere && (
                  <ServiceWizard
                    locationId={loc.id}
                    locationName={loc.name}
                    allServices={services}
                    setError={setError}
                    onCancel={() => setAddingServiceFor(null)}
                    onAdded={refreshCore}
                    onDone={() => { setAddingServiceFor(null); refreshCore(); refreshLicenses(); }}
                    tenant={tenant}
                  />
                )}

                {locServices.length === 0 && !addingHere && <div className="muted small">No services here yet — use "Add service" above.</div>}
                {locServices.map((s) => (
                  <ServiceEditor
                    key={s.id} statusInHeader={locServices.length === 1} service={s} allServices={services} tenant={tenant} setError={setError}
                    locationName={loc.name}
                    locationCode={loc.code}
                    onChange={() => { refreshCore(); refreshLicenses(); }}
                    autoBuy={renewServiceId === s.id}
                    onAutoBuyHandled={() => setRenewServiceId(null)}
                    startExpanded={locServices.length === 1}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {tab === "profile" && (
        <ProfileTab
          tenant={tenant} onTenantChange={onTenantChange} onAccountDeleted={onAccountDeleted}
          licenses={allLicenses} onLicensesChanged={refreshLicenses} setError={setError}
          staffAppUrl={STAFF_APP_URL} customerLink={customerLink}
        />
      )}

      {/* Shop tab is hidden for now (future feature) — ShopTab below is kept, just unreachable
          until "shop" is added back to the tab list above. */}
      {tab === "staff" && <StaffTab staffAppUrl={STAFF_APP_URL} setError={setError} />}
      {tab === "shop" && <ShopTab tenant={tenant} locations={locations} />}

      {tab === "dashboard" && (
        <div className="stack" style={{ gap: 16 }}>
          {endingToday.length > 0 && (
            <div className="alert-strip" role="status">
              {endingToday.map((l) => (
                <div key={l.id} className="alert-row">
                  <span><strong>{l.service_name}</strong> licence ends today</span>
                  <button type="button" className="btn btn-accent" onClick={() => renewService(l.service_id)}>Renew</button>
                </div>
              ))}
            </div>
          )}

          {todayServices.length > 0 && <TodayPanel services={todayServices} />}

          {stats && (
            <section className="stack" style={{ gap: 8 }} aria-label="Today at a glance">
              <div className="stat-grid">
                <div className="stat"><div className="stat-num">{stats.waiting}</div><div className="stat-label">Waiting</div></div>
                <div className="stat"><div className="stat-num blue">{stats.serving}</div><div className="stat-label">Serving</div></div>
                <div className="stat"><div className="stat-num">{stats.booked}</div><div className="stat-label">Booked</div></div>
                <div className="stat"><div className="stat-num">{stats.completed}</div><div className="stat-label">Completed</div></div>
              </div>
              <div className="muted small">No-show {stats.no_show} · Cancelled {stats.cancelled} · {visibleLocations.length} location{visibleLocations.length === 1 ? "" : "s"} · {visibleServices.length} active service{visibleServices.length === 1 ? "" : "s"}</div>
            </section>
          )}

          {setupPercent < 100 && (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2>Finish setting up your account</h2>
                <span className="muted small">{setupPercent}% complete</span>
              </div>
              <div role="progressbar" aria-label="Account setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={setupPercent} style={{ height: 6, borderRadius: 3, background: "#EAE9E3", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${setupPercent}%`, background: "var(--brand)", borderRadius: 3 }} />
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {setupTasks.filter((t) => !t.done).map((t) => {
                  const isPayment = t.key === "payment";
                  return (
                    <div
                      key={t.key} className="row wrap"
                      style={{
                        justifyContent: "space-between", gap: 8,
                        ...(isPayment ? { background: "#FBE9E7", padding: "8px 10px" } : null),
                      }}
                    >
                      <span className="grow" style={{ fontSize: 14, minWidth: 180, color: isPayment ? "#B3261E" : undefined, fontWeight: isPayment ? 600 : undefined }}>{t.label}</span>
                      <div className="row">
                        <button className="btn-outline" onClick={t.go} style={isPayment ? { borderColor: "#B3261E", color: "#B3261E" } : undefined}>{t.cta}</button>
                        <button
                          className="btn-outline icon-btn"
                          title="Dismiss — won't be shown again"
                          aria-label={`Dismiss: ${t.label}`}
                          style={{ border: "none", background: "transparent" }}
                          onClick={() => dismissSetupTask(t.key)}
                        >✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <section className="stack" style={{ gap: 8 }} aria-label="Today's tickets">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2>Today's tickets</h2>
              <button className="btn-outline" onClick={refreshQueue}>Refresh</button>
            </div>

            <div className="show-narrow stack">
              <div className="chips" role="group" aria-label="Filter tickets">
                {[["all", "All"], ["waiting", "Waiting"], ["serving", "Serving"], ["booked", "Booked"], ["completed", "Done"]].map(([k, label]) => (
                  <button key={k} type="button" className={`chip${ticketFilter === k ? " on" : ""}`} aria-pressed={ticketFilter === k} onClick={() => setTicketFilter(k)}>
                    {label} {k === "all" ? tickets.length : tickets.filter((t) => t.status === k).length}
                  </button>
                ))}
              </div>
              {tickets.length === 0 && <div className="list-card muted" style={{ textAlign: "center" }}>No tickets today.</div>}
              {filteredTickets.map((t) => (
                <div key={t.id} className="t-card">
                  <div className="t-top">
                    <div className="t-num">{t.ticket_number}</div>
                    <span className={`badge ${ticketBadge(t).cls}`}>{ticketBadge(t).text}</span>
                  </div>
                  <div className="t-svc">{services.find((s) => s.id === t.service_id)?.name || "—"} <span className="muted" style={{ fontWeight: 400 }}>· {t.type === "booked" ? `Booked ${formatTime(t.slot_time)}` : "Walk-in"}</span></div>
                  <div className="t-actions">
                    {moveSelect(t)}
                    <button type="button" className="btn-outline danger" onClick={() => deleteTicket(t)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="show-wide card" style={{ padding: 0, overflowX: "auto" }}>
              <table>
                <thead><tr><th>Ticket</th><th>Service</th><th>Type/time</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {tickets.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 16 }}>No tickets today.</td></tr>}
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="cell-mono">{t.ticket_number}</td>
                      <td>{services.find((s) => s.id === t.service_id)?.name || "—"}</td>
                      <td>{t.type === "booked" ? formatTime(t.slot_time) : "Walk-in"}</td>
                      <td><span className={`badge ${ticketBadge(t).cls}`}>{ticketBadge(t).text}</span></td>
                      <td>
                        <div className="row">
                          {moveSelect(t)}
                          <button type="button" className="btn-outline danger" onClick={() => deleteTicket(t)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === "audit" && (
        <div className="stack" style={{ gap: 16 }}>
          {archivedLocations.length > 0 && (
            <div className="card stack">
              <h2>Archived locations ({archivedLocations.length})</h2>
              {archivedLocations.map((loc) => (
                <div key={loc.id} className="list-row">
                  <span className="grow" style={{ fontSize: 15 }}>{loc.name}</span>
                  <button className="btn-outline" onClick={async () => { try { await api.unarchiveLocation(loc.id); refreshCore(); } catch (err) { setError(err.message); } }}>Unarchive</button>
                </div>
              ))}
            </div>
          )}
          {archivedServices.length > 0 && (
            <div className="card stack">
              <h2>Archived services ({archivedServices.length})</h2>
              {archivedServices.map((s) => {
                const loc = locations.find((l) => l.id === s.location_id);
                return (
                  <div key={s.id} className="list-row">
                    <span className="grow" style={{ fontSize: 15 }}>{s.name} <span className="muted">— {loc?.name || "—"}</span></span>
                    <button
                      className="btn-outline"
                      onClick={async () => {
                        try {
                          // Unarchiving a service whose location is still archived would leave it
                          // stranded out of view — bring the location back too so it's reachable.
                          if (loc?.archived) await api.unarchiveLocation(loc.id);
                          await api.updateService(s.id, { archived: false });
                          refreshCore();
                        } catch (err) { setError(err.message); }
                      }}
                    >
                      Unarchive
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="card stack" style={{ gap: 0 }}>
            <h2 style={{ marginBottom: 10 }}>Activity</h2>
            {auditLog.length === 0 && <div className="muted">No activity yet.</div>}
            {auditLog.map((a) => <div key={a.id} className="log-row"><time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time><span>{a.message}</span></div>)}
          </div>
        </div>
      )}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {PHONE_TABS.map((t) => (
          <button key={t} type="button" className={tab === t ? "active" : undefined} aria-current={tab === t ? "page" : undefined} onClick={() => goTab(t)}>
            <NavIcon name={t} />{TAB_TITLES[t]}
          </button>
        ))}
        <button type="button" className={moreActive ? "active" : undefined} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
          <NavIcon name="more" />More
        </button>
      </nav>
      {moreOpen && (
        <>
          <div className="sheet-backdrop phone-only" onClick={() => setMoreOpen(false)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="More">
            <div className="sheet-title">More</div>
            <button type="button" className={tab === "audit" ? "active" : undefined} autoFocus onClick={() => goTab("audit")}><NavIcon name="audit" />Audit log</button>
            <button type="button" className={tab === "shop" ? "active" : undefined} onClick={() => goTab("shop")}><NavIcon name="shop" />Shop</button>
            <button type="button" onClick={() => { setMoreOpen(false); onSignOut(); }}><NavIcon name="signout" />Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

// Email and company address are editable here — business name isn't (it's used across
// receipts/audit history; contact us to change it). Also the one place licenses across
// every service are listed together, with Refund/Print moved here from each service's own
// licenses panel so that panel stays focused on scheduling.
function splitAddress(combined) {
  const parts = (combined || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 4) return { line1: parts[0], line2: parts[1], city: parts[2], postcode: parts[3] };
  if (parts.length === 3) return { line1: parts[0], line2: "", city: parts[1], postcode: parts[2] };
  if (parts.length === 2) return { line1: parts[0], line2: "", city: "", postcode: parts[1] };
  if (parts.length === 1) return { line1: parts[0], line2: "", city: "", postcode: "" };
  return { line1: "", line2: "", city: "", postcode: "" };
}
function combineAddress(line1, line2, city, postcode) {
  return [line1, line2, city, postcode].map((s) => (s || "").trim()).filter(Boolean).join(", ");
}

// "How patients join" — which channels a location offers, per the ChannelAdmin design.
// The location code (also the WhatsApp code) is what the QR carries, and what "only joinable
// from the clinic" checks. It does not check where the patient physically is.
const CHANNEL_CHOICES = [
  { value: "whatsapp", title: "WhatsApp only", text: "Patients message your number. WhatsApp message charges apply." },
  { value: "web", title: "Web page only", text: "Looks like a chat, opens in the browser. No message charges." },
  { value: "both", title: "Both", text: "Patients choose. Most will use the web page, so you pay for fewer messages.", recommended: true },
];

function ChannelSettings({ loc, tenant, onSaved }) {
  const saved = { mode: loc.channel_mode || "both", offer: loc.whatsapp_updates_offer !== false, onsite: !!loc.onsite_only };
  const [mode, setMode] = useState(saved.mode);
  const [offer, setOffer] = useState(saved.offer);
  const [onsite, setOnsite] = useState(saved.onsite);
  const [status, setStatus] = useState({ kind: "idle", text: "" }); // idle | saving | ok | error
  const dirty = mode !== saved.mode || offer !== saved.offer || onsite !== saved.onsite;
  const CUSTOMER_APP_URL = import.meta.env.VITE_CUSTOMER_APP_URL || "http://localhost:5177";
  const previewHref = `${CUSTOMER_APP_URL}/?t=${tenant.id}${loc.code ? `&c=${encodeURIComponent(loc.code)}` : ""}`;

  async function save() {
    setStatus({ kind: "saving", text: "Saving…" });
    try {
      await api.updateLocation(loc.id, { channelMode: mode, whatsappUpdatesOffer: offer, onsiteOnly: onsite });
      await onSaved?.();
      setStatus({ kind: "ok", text: "Saved. Patients see the new setting straight away." });
    } catch (err) {
      setStatus({ kind: "error", text: `Not saved: ${err.message}` });
    }
  }

  return (
    <section className="card stack chan" aria-labelledby={`chan-h-${loc.id}`} style={{ gap: 14 }}>
      <h2 id={`chan-h-${loc.id}`} className="chan-h">How patients join</h2>
      <p className="muted chan-lede">One QR code and location code works for every option. Patients pick on their phone, or you can limit it.</p>

      <fieldset className="chan-group">
        <legend className="sr-only">How patients join {loc.name}</legend>
        {CHANNEL_CHOICES.map((c) => (
          <label key={c.value} className={`chan-opt${mode === c.value ? " is-on" : ""}`}>
            <input type="radio" name={`channel-${loc.id}`} value={c.value} checked={mode === c.value} onChange={() => { setMode(c.value); setStatus({ kind: "idle", text: "" }); }} />
            <span className="chan-radio" aria-hidden="true" />
            <span className="chan-opt-body">
              <span className="chan-opt-title"><strong>{c.title}</strong>{c.recommended && <span className="badge badge-green">Recommended</span>}</span>
              <span className="chan-opt-text">{c.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className={`chan-row${mode === "whatsapp" ? " is-disabled" : ""}`}>
        <span className="chan-row-text" id={`offer-l-${loc.id}`}>
          <strong>Offer WhatsApp updates to web users</strong>
          <span className="small muted">A button to be messaged when nearly up{mode === "whatsapp" ? " (not used when WhatsApp only)" : ""}</span>
        </span>
        <button type="button" role="switch" aria-checked={offer && mode !== "whatsapp"} aria-labelledby={`offer-l-${loc.id}`} disabled={mode === "whatsapp"}
          className={`chan-switch${offer && mode !== "whatsapp" ? " is-on" : ""}`} onClick={() => { setOffer(!offer); setStatus({ kind: "idle", text: "" }); }}><span className="chan-knob" /></button>
      </div>

      <div className="chan-row">
        <span className="chan-row-text" id={`onsite-l-${loc.id}`}>
          <strong>Only joinable from the clinic</strong>
          <span className="small muted">Patients must scan the QR code at reception or enter your location code{loc.code ? ` (${loc.code})` : ""}. Stops people joining the queue from home by accident. It checks the code, not where the phone is.</span>
        </span>
        <button type="button" role="switch" aria-checked={onsite} aria-labelledby={`onsite-l-${loc.id}`}
          className={`chan-switch${onsite ? " is-on" : ""}`} onClick={() => { setOnsite(!onsite); setStatus({ kind: "idle", text: "" }); }}><span className="chan-knob" /></button>
      </div>

      <div className="chan-actions">
        <button type="button" className="btn btn-accent" disabled={!dirty || status.kind === "saving"} onClick={save}>{status.kind === "saving" ? "Saving…" : "Save"}</button>
        <a className="btn-outline" href={previewHref} target="_blank" rel="noopener noreferrer">Preview</a>
      </div>
      <div className={`chan-status chan-status-${status.kind}`} role={status.kind === "error" ? "alert" : "status"} aria-live="polite">{status.kind === "saving" ? "" : status.text}</div>
    </section>
  );
}

// The location's name as the page title, editable in place and saved automatically
// (shortly after typing stops, and on Enter or leaving the field).
function LocationNameField({ loc, onSaved, setError }) {
  const [value, setValue] = useState(loc.name);
  const [state, setState] = useState("idle"); // idle | saving | saved
  const timer = useRef(null);
  const last = useRef(loc.name);
  async function save(v) {
    const name = v.trim();
    if (!name || name === last.current) return;
    setState("saving");
    try {
      await api.updateLocation(loc.id, { name });
      last.current = name;
      setState("saved");
      onSaved?.();
      setTimeout(() => setState("idle"), 1500);
    } catch (err) { setState("idle"); setError(err.message); }
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="loc-name-wrap">
      <label className="sr-only" htmlFor={`locname-${loc.id}`}>Location name</label>
      <input
        id={`locname-${loc.id}`}
        className="loc-name-input"
        value={value}
        onChange={(e) => { setValue(e.target.value); clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => save(v), 800); }}
        onBlur={() => { clearTimeout(timer.current); if (!value.trim()) setValue(last.current); else save(value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
      <span className="loc-name-status" aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}</span>
    </div>
  );
}

// A service's name as an always-visible bordered text box that saves itself, like the location name.
function ServiceNameField({ service, onSaved, setError }) {
  const [value, setValue] = useState(service.name);
  const [state, setState] = useState("idle");
  const timer = useRef(null);
  const last = useRef(service.name);
  async function save(v) {
    const name = v.trim();
    if (!name || name === last.current) return;
    setState("saving");
    try {
      await api.updateService(service.id, { name });
      last.current = name;
      setState("saved");
      onSaved?.();
      setTimeout(() => setState("idle"), 1500);
    } catch (err) { setState("idle"); setError(err.message); }
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="svc-name-wrap">
      <label className="sr-only" htmlFor={`svcname-${service.id}`}>Service name</label>
      <input
        id={`svcname-${service.id}`}
        className="svc-name-input"
        value={value}
        maxLength={80}
        onChange={(e) => { setValue(e.target.value); clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => save(v), 800); }}
        onBlur={() => { clearTimeout(timer.current); if (!value.trim()) setValue(last.current); else save(value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
      <span className="loc-name-status" aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}</span>
    </div>
  );
}

// Named staff users. Each person signs in to the staff portal with their email plus a code sent to
// it, and every ticket they call is recorded against their name.
function StaffTab({ staffAppUrl, setError }) {
  const [staff, setStaff] = useState(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "" });
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ firstName: "", lastName: "", email: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    try { const r = await api.getStaff(); setStaff(r.staff); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setBusy(true);
    try { await api.addStaff(form); setForm({ firstName: "", lastName: "", email: "" }); setAdding(false); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function save(id) {
    setBusy(true);
    try { await api.updateStaff(id, edit); setEditId(null); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove(m) {
    if (!confirm(`Remove ${m.first_name} ${m.last_name}? They'll be signed out and won't be able to sign in to the staff portal.`)) return;
    try { await api.deleteStaff(m.id); await load(); } catch (err) { setError(err.message); }
  }

  const staffFormValid = (f) => f.firstName.trim() && f.lastName.trim() && f.email.trim();
  function startEdit(m) { setEditId(m.id); setEdit({ firstName: m.first_name, lastName: m.last_name, email: m.email }); }
  function editFields() {
    return (
      <div className="form-grid">
        <label className="field"><span className="field-label">First name</span>
          <input className="input" value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></label>
        <label className="field"><span className="field-label">Last name</span>
          <input className="input" value={edit.lastName} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></label>
        <label className="field span2"><span className="field-label">Email address</span>
          <input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <div className="row wrap" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="stack grow" style={{ gap: 2, minWidth: 220 }}>
            <strong>Staff</strong>
            <span className="muted small">
              Add everyone who needs to call customers forward. They sign in to the staff portal with their email address and a code sent to it.
              {staffAppUrl && <> Staff portal: <a href={staffAppUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: "anywhere" }}>{staffAppUrl}</a></>}
            </span>
          </div>
          {!adding && <button className="btn" onClick={() => setAdding(true)}>+ Add staff member</button>}
        </div>
        {adding && (
          <div className="stack">
            <div className="form-grid">
              <label className="field"><span className="field-label">First name</span>
                <input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></label>
              <label className="field"><span className="field-label">Last name</span>
                <input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></label>
              <label className="field span2"><span className="field-label">Email address</span>
                <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            </div>
            <div className="form-actions">
              <button className="btn" disabled={busy || !staffFormValid(form)} onClick={add}>{busy ? "Adding…" : "Add"}</button>
              <button className="btn-outline" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Phones: one card per person */}
      <div className="show-narrow stack">
        {staff === null && <div className="list-card muted" style={{ textAlign: "center" }}>Loading…</div>}
        {staff && staff.length === 0 && <div className="list-card muted" style={{ textAlign: "center" }}>No staff yet — add your first staff member above.</div>}
        {staff && staff.map((m) => editId === m.id ? (
          <div key={m.id} className="list-card">
            {editFields()}
            <div className="form-actions">
              <button className="btn" disabled={busy || !staffFormValid(edit)} onClick={() => save(m.id)}>Save</button>
              <button className="btn-outline" onClick={() => setEditId(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div key={m.id} className="list-card">
            <div>
              <div className="loc-name">{m.first_name} {m.last_name}</div>
              <div className="muted" style={{ fontSize: 14, overflowWrap: "anywhere" }}>{m.email}</div>
            </div>
            <div className="t-actions">
              <button className="btn-outline" style={{ flex: 1 }} onClick={() => startEdit(m)} aria-label={`Edit ${m.first_name} ${m.last_name}`}>Edit</button>
              <button className="btn-outline danger" style={{ flex: 1 }} onClick={() => remove(m)} aria-label={`Delete ${m.first_name} ${m.last_name}`}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Wide screens: table */}
      <div className="show-wide card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead><tr><th>First name</th><th>Last name</th><th>Email</th><th></th></tr></thead>
          <tbody>
            {staff === null && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 12 }}>Loading…</td></tr>}
            {staff && staff.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 12 }}>No staff yet — add your first staff member above.</td></tr>}
            {staff && staff.map((m) => editId === m.id ? (
              <tr key={m.id}>
                <td><input className="input" aria-label="First name" value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></td>
                <td><input className="input" aria-label="Last name" value={edit.lastName} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></td>
                <td><input className="input" aria-label="Email address" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn" disabled={busy || !staffFormValid(edit)} onClick={() => save(m.id)}>Save</button>
                    <button className="btn-outline" onClick={() => setEditId(null)}>Cancel</button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={m.id}>
                <td>{m.first_name}</td><td>{m.last_name}</td><td>{m.email}</td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn-outline" onClick={() => startEdit(m)} aria-label={`Edit ${m.first_name} ${m.last_name}`}>Edit</button>
                    <button className="btn-outline danger" onClick={() => remove(m)} aria-label={`Delete ${m.first_name} ${m.last_name}`}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfileTab({ tenant, onTenantChange, onAccountDeleted, licenses, onLicensesChanged, setError, staffAppUrl, customerLink }) {
  const [businessName, setBusinessName] = useState(tenant.business_name || "");
  const [firstName, setFirstName] = useState(tenant.first_name || "");
  const [lastName, setLastName] = useState(tenant.last_name || "");
  const [email, setEmail] = useState(tenant.email || "");
  const [website, setWebsite] = useState(tenant.website_url || "");
  const initialAddress = splitAddress(tenant.company_address);
  const [line1, setLine1] = useState(initialAddress.line1);
  const [line2, setLine2] = useState(initialAddress.line2);
  const [city, setCity] = useState(initialAddress.city);
  const [postcode, setPostcode] = useState(initialAddress.postcode);
  const [saved, setSaved] = useState(false);
  const [payMethod, setPayMethod] = useState(null); // null | "card" | "invoice"
  const [payInvoiceEmail, setPayInvoiceEmail] = useState(tenant.invoice_email || "");
  const [payInvoicePO, setPayInvoicePO] = useState(tenant.invoice_po || "");
  const [paying, setPaying] = useState(false);

  const dirty = businessName !== (tenant.business_name || "")
    || firstName !== (tenant.first_name || "") || lastName !== (tenant.last_name || "")
    || email !== (tenant.email || "") || website !== (tenant.website_url || "")
    || combineAddress(line1, line2, city, postcode) !== (tenant.company_address || "");

  async function save() {
    try {
      const r = await api.updateMe({
        businessName, firstName, lastName, email,
        websiteUrl: website.trim() || null,
        companyAddress: combineAddress(line1, line2, city, postcode),
      });
      onTenantChange?.(r.tenant);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err.message);
    }
  }

  async function payLater(lic, method) {
    let po;
    if (method === "invoice") {
      po = prompt("PO / reference number for the invoice:", tenant.invoice_po || "");
      if (!po || !po.trim()) return;
    } else if (!confirm("Card payments via Stripe are coming soon — for now this marks the license as paid without a real charge. Continue?")) return;
    try {
      await api.payServiceLicense(lic.service_id, lic.id, { paymentMethod: method, invoiceEmail: method === "invoice" ? tenant.invoice_email || undefined : undefined, invoicePO: po });
      onLicensesChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function refund(lic) {
    if (!confirm(`Refund this ${lic.plan_label} license on "${lic.service_name}"? This can't be undone.`)) return;
    try {
      await api.refundServiceLicense(lic.service_id, lic.id);
      onLicensesChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  const visibleLicenses = licenses.filter((l) => l.status !== "refunded");
  const accountUnpaid = tenant.status === "pending";

  async function payByCard() {
    if (!confirm("Card payment via Stripe is coming soon — for now this activates your account immediately without a real charge. Continue?")) return;
    setPaying(true);
    try {
      const r = await api.payNow({ paymentMethod: "card" });
      onTenantChange?.(r.tenant);
      setPayMethod(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setPaying(false);
    }
  }
  async function payByInvoice() {
    setPaying(true);
    try {
      const r = await api.payNow({ paymentMethod: "invoice", invoiceEmail: payInvoiceEmail, invoicePO: payInvoicePO });
      onTenantChange?.(r.tenant);
      setPayMethod(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setPaying(false);
    }
  }

  async function deleteAccount() {
    const typed = prompt(
      `This permanently deletes your account "${tenant.business_name}" — every location, service, license and booking history goes with it, and this can't be undone.\n\nType DELETE to confirm.`
    );
    if (typed !== "DELETE") return;
    try {
      await api.deleteMyAccount();
      onAccountDeleted?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <h2>Your details</h2>
        <div className="form-grid">
          <label className="field span2">
            <span className="field-label">Business name</span>
            <input className="input" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">First name</span>
            <input className="input" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Last name</span>
            <input className="input" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Email address</span>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Website</span>
            <input className="input" type="url" inputMode="url" placeholder="https://yourbusiness.example" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
        </div>

        <h2 style={{ marginTop: 4 }}>Business address</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Address line 1</span>
            <input className="input" autoComplete="address-line1" value={line1} onChange={(e) => setLine1(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Address line 2</span>
            <input className="input" autoComplete="address-line2" value={line2} onChange={(e) => setLine2(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">City</span>
            <input className="input" autoComplete="address-level2" value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Post / zip code</span>
            <input className="input" autoComplete="postal-code" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          </label>
        </div>

        <div className="form-actions">
          <button className="btn" disabled={!dirty} onClick={save}>Save</button>
          {saved && <span className="muted small" role="status">Saved.</span>}
        </div>
      </div>

      {accountUnpaid && (
        <div className="card stack" style={{ borderColor: "var(--accent)" }}>
          <h2>Payment required</h2>
          <div className="muted small">
            Staff kiosk and customer WhatsApp are switched off until payment is settled. Configure everything now — it'll switch on as soon as payment goes through.
          </div>
          {!payMethod && (
            <div className="form-actions">
              <button className="btn" onClick={() => setPayMethod("card")}>Pay by card</button>
              <button className="btn-outline" onClick={() => setPayMethod("invoice")}>Pay by invoice</button>
            </div>
          )}
          {payMethod === "card" && (
            <div className="form-actions">
              <button className="btn" disabled={paying} onClick={payByCard}>{paying ? "Processing…" : "Confirm card payment"}</button>
              <button className="btn-outline" onClick={() => setPayMethod(null)}>Cancel</button>
            </div>
          )}
          {payMethod === "invoice" && (
            <div className="stack">
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Billing email</span>
                  <input className="input" type="email" value={payInvoiceEmail} onChange={(e) => setPayInvoiceEmail(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">PO / reference number</span>
                  <input className="input" value={payInvoicePO} onChange={(e) => setPayInvoicePO(e.target.value)} />
                </label>
              </div>
              <div className="form-actions">
                <button className="btn" disabled={paying || !payInvoicePO.trim()} onClick={payByInvoice}>{paying ? "Submitting…" : "Submit for invoicing"}</button>
                <button className="btn-outline" onClick={() => setPayMethod(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card stack" style={{ background: "var(--accent-weak)" }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="small">Staff Kiosk link</span>
          <code style={{ fontSize: 13, background: "#fff", padding: "6px 8px", overflowWrap: "anywhere" }}>{staffAppUrl}</code>
        </div>
        <div className="muted small">
          Staff sign in with their own email address and a code sent to it. Add them in the Staff tab.
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="small">Customer link</span>
          <div className="row wrap">
            <code className="grow" style={{ fontSize: 13, background: "#fff", padding: "6px 8px", overflowWrap: "anywhere", minWidth: 200 }}>{customerLink}</code>
            <button className="btn-outline" onClick={() => { navigator.clipboard?.writeText(customerLink); }}>Copy</button>
          </div>
        </div>
        <div className="muted small">This is what a real customer link would open, once WhatsApp is wired up for real — useful for testing your setup now.</div>
      </div>

      <div className="card stack">
        <h2>Licenses ({visibleLicenses.length})</h2>
        {visibleLicenses.length === 0 && <div className="muted small">No licenses yet.</div>}
        <div>
          {visibleLicenses.map((lic) => {
            const meta = LICENSE_STATUS_META[lic.status] || { label: lic.status, color: "blue" };
            const unpaidLater = lic.paid === false && lic.payment_method === "later";
            const canRefund = (lic.status === "available" || lic.status === "scheduled") && Number(lic.price) > 0 && !accountUnpaid && !unpaidLater;
            return (
              <div key={lic.id} className="lic-card">
                <div className="lic-main">
                  <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                  <strong style={{ fontSize: 15 }}>{lic.service_name}</strong>
                  <span>{lic.plan_label}</span>
                  {unpaidLater && <span className="badge badge-red">Unpaid — pay later</span>}
                </div>
                <div className="muted small">
                  {lic.start_date && <>{formatDateDisplay(lic.start_date)} to {formatDateDisplay(lic.end_date)} · </>}
                  {Number(lic.price) > 0 ? priceText(lic.price) : "Free"}
                </div>
                <div className="lic-actions">
                  {unpaidLater && (
                    <>
                      <button className="btn" onClick={() => payLater(lic, "card")}>Pay by card</button>
                      <button className="btn-outline" onClick={() => payLater(lic, "invoice")}>Pay by invoice</button>
                    </>
                  )}
                  {canRefund && <button className="btn-outline" onClick={() => refund(lic)}>Refund</button>}
                  <button className="btn-outline" onClick={() => printLicenseReceipt(lic, lic.service_name, tenant.business_name, tenant.company_address)}>Print receipt</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card stack" style={{ borderColor: "var(--error)" }}>
        <h2 style={{ color: "var(--error)" }}>Delete account</h2>
        <div className="muted small">
          This will permanently delete all of your data — every location, service, license and booking history. This can't be undone.
        </div>
        <div>
          <button className="btn-outline danger" onClick={deleteAccount}>Delete account</button>
        </div>
      </div>
    </div>
  );
}

function ShopTab({ tenant, locations }) {
  function downloadBrochure() {
    const withCodes = locations.filter((l) => l.code);
    if (withCodes.length === 0) {
      alert("No locations with a WhatsApp code yet — add a location first.");
      return;
    }
    const cards = withCodes.map((l) => `
      <div style="border:2px solid #1B1D1F;border-radius:14px;padding:32px;margin-bottom:28px;text-align:center;page-break-inside:avoid;">
        <div style="font-size:22px;font-weight:700;margin-bottom:4px;">${tenant.business_name}</div>
        <div style="font-size:14px;color:#5F615B;margin-bottom:20px;">${l.name}</div>
        <div style="font-size:17px;font-weight:600;margin-bottom:10px;">📱 Message us on WhatsApp to get started</div>
        <div style="font-size:15px;color:#1B1D1F;margin-bottom:6px;">Send this code:</div>
        <div style="font-size:28px;font-weight:700;letter-spacing:2px;background:#F7F7F4;border-radius:8px;padding:10px 0;">${l.code}</div>
        <div style="font-size:12px;color:#5F615B;margin-top:18px;">Join the queue or book a slot instantly — no app to download.</div>
      </div>
    `).join("");
    const html = `<!doctype html><html><head><title>QBooker brochure — ${tenant.business_name}</title>
      <meta charset="utf-8" />
      <style>body{font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:40px auto;color:#1B1D1F;}</style>
      </head><body>${cards}<p style="text-align:center;color:#5F615B;font-size:11px;">Print this page and display it in your waiting area.</p></body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }

  function enquire(subject) {
    window.open(`mailto:hello@qbooker.example?subject=${encodeURIComponent(subject)}`, "_blank");
  }

  const products = [
    { name: "QR Code Brochure", price: "Free", desc: "A printable page for your waiting area with your WhatsApp sign-in code — customers message it to join the queue or book instantly.", action: { label: "Download brochure", onClick: downloadBrochure } },
    { name: "Floor-standing Banner", price: "Get a quote", desc: "A pull-up banner for your entrance or waiting area, printed with your business name and WhatsApp code built in.", action: { label: "Get a quote", onClick: () => enquire("Floor-standing banner enquiry") } },
    { name: "Desktop Touch-Screen Kiosk", price: "Get a quote", desc: "A compact touch-screen unit for a reception desk or counter, so walk-in customers can check themselves in without staff involvement.", action: { label: "Get a quote", onClick: () => enquire("Desktop touch-screen kiosk enquiry") } },
    { name: "Floor-standing Kiosk", price: "Get a quote", desc: "A free-standing self-check-in kiosk for busier waiting areas and lobbies.", action: { label: "Get a quote", onClick: () => enquire("Floor-standing kiosk enquiry") } },
  ];

  const services = [
    { name: "Remote Staff Training", price: "Get a quote", desc: "A video session with your team covering the Staff Kiosk — calling tickets, handling no-shows, day-to-day use.", action: { label: "Get a quote", onClick: () => enquire("Remote staff training enquiry") } },
    { name: "Admin System Set-up", price: "£125 (£150 inc VAT)", desc: "Our team configures your services, hours, and staffing for you — done in one session.", action: { label: "Enquire", onClick: () => enquire("Admin system set-up enquiry") } },
  ];

  return (
    <div className="stack">
      <div className="muted small">
        A look at what's available — nothing here is purchased automatically yet, "Get a quote" opens an email to us directly.
      </div>

      <h2>Products</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {products.map((p) => (
          <div key={p.name} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong style={{ fontSize: 14 }}>{p.name}</strong>
              <span className={`badge ${p.price === "Free" ? "badge-green" : "badge-blue"}`}>{p.price}</span>
            </div>
            <div className="muted small">{p.desc}</div>
            <div><button className="btn-outline" onClick={p.action.onClick}>{p.action.label}</button></div>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 8 }}>Services</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {services.map((s) => (
          <div key={s.name} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong style={{ fontSize: 14 }}>{s.name}</strong>
              <span className="badge badge-blue">{s.price}</span>
            </div>
            <div className="muted small">{s.desc}</div>
            <div><button className="btn-outline" onClick={s.action.onClick}>{s.action.label}</button></div>
          </div>
        ))}
      </div>
    </div>
  );
}

const LICENSE_STATUS_META = {
  available: { label: "Available", color: "amber" },
  scheduled: { label: "Scheduled", color: "blue" },
  active: { label: "Active", color: "green" },
  expired: { label: "Expired", color: "red" },
  refunded: { label: "Refunded", color: "red" },
};

// Shared by the Profile tab's licenses list and each service's own licenses panel.
function printLicenseReceipt(lic, serviceName, businessName, businessAddress) {
  const rows = [
    ["Service", serviceName],
    ["Plan", lic.plan_label],
    ["Status", LICENSE_STATUS_META[lic.status]?.label || lic.status],
    ...(lic.start_date ? [["Dates", `${formatDateDisplay(lic.start_date)} to ${formatDateDisplay(lic.end_date)}`]] : []),
    ...(lic.price != null ? [
      ["Price", exMoney(lic.price)],
      [`VAT (${VAT_RATE * 100}%)`, exMoney(incVat(lic.price) - Number(lic.price))],
      ["Total (inc VAT)", exMoney(incVat(lic.price))],
    ] : [["Price", "—"]]),
    ["Purchased", lic.purchased_at ? new Date(lic.purchased_at).toLocaleDateString() : "—"],
  ];
  const html = `<!doctype html><html><head><title>Receipt — ${businessName}</title>
    <meta charset="utf-8" />
    <style>
      body{font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:40px auto;color:#1B1D1F;}
      h1{font-size:20px;margin-bottom:2px;}
      .addr{color:#5F615B;font-size:12px;margin-bottom:4px;}
      .sub{color:#5F615B;font-size:13px;margin-bottom:24px;}
      table{width:100%;border-collapse:collapse;}
      td{padding:8px 0;border-bottom:1px solid #E6E6E1;font-size:14px;}
      td:first-child{color:#5F615B;width:40%;}
      td:last-child{font-weight:600;text-align:right;}
    </style>
    </head><body>
      <h1>${businessName}</h1>
      ${businessAddress ? `<div class="addr">${businessAddress}</div>` : ""}
      <div class="sub">License receipt</div>
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
    </body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) w.onload = () => w.print();
}

function shortDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
// One-line licence summary for a location card, built from the licences already loaded.
function locationLicenceText(locServices, allLicenses, today) {
  if (locServices.length === 0) return "no services yet";
  const live = (l) => l.status !== "refunded" && l.status !== "expired";
  const activeBySvc = locServices.map((s) => allLicenses.find((l) => l.service_id === s.id && l.status === "active")).filter(Boolean);
  const endingToday = activeBySvc.filter((l) => l.end_date === today).length;
  if (endingToday > 0) return `${endingToday} licence${endingToday === 1 ? "" : "s"} ending today`;
  if (activeBySvc.length === locServices.length) {
    const earliest = activeBySvc.map((l) => l.end_date).sort()[0];
    return `licensed to ${shortDate(earliest)}`;
  }
  if (activeBySvc.length > 0) return `${activeBySvc.length} of ${locServices.length} licensed`;
  const pending = allLicenses.filter((l) => locServices.some((s) => s.id === l.service_id) && live(l)).length;
  return pending > 0 ? "licence not yet scheduled" : "no licence yet";
}

function licencePayText(l) {
  if (l.paid === false) return l.payment_method === "invoice" ? "Invoice, awaiting payment" : "Unpaid";
  if (l.payment_method === "card") return "Paid by card";
  if (l.payment_method === "invoice") return "Invoiced";
  return "";
}
// The licence that matters right now: the live one, otherwise the next one coming up.
function currentLicenceOf(licenses) {
  return licenses.find((l) => l.status === "active") || licenses.filter((l) => l.status === "scheduled").sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""))[0];
}
function licenceDetailText(l) {
  const parts = [`${l.plan_label} licence${l.start_date ? ` · ${shortDate(l.start_date)} to ${shortDate(l.end_date)}` : ""}`];
  if (Number(l.price) > 0) parts.push(priceText(l.price));
  const pay = licencePayText(l);
  if (pay) parts.push(pay);
  return parts.join(" · ");
}
// Compact status line directly under the location name: licence badge + one line of licence detail
// for a sole service, or the location-level licence summary when there are several services.
function LocationStatusLine({ services, allLicenses, today }) {
  if (services.length === 1) {
    const lics = allLicenses.filter((l) => l.service_id === services[0].id);
    const summary = licenseSummary(lics);
    const cur = currentLicenceOf(lics.filter((l) => l.status !== "refunded" && l.status !== "expired"));
    return (
      <div className="loc-status" data-testid="loc-status">
        <span className={`badge badge-${summary.color}`}>{summary.text}</span>
        {cur && <span className="muted small">{licenceDetailText(cur)}</span>}
      </div>
    );
  }
  return (
    <div className="loc-status" data-testid="loc-status">
      <span className="muted small">{services.length} service{services.length === 1 ? "" : "s"} · {locationLicenceText(services, allLicenses, today)}</span>
    </div>
  );
}

// A compact, always-visible summary of a service's license health — shown in the
// collapsed header row so you don't have to expand every service to check coverage.
function licenseSummary(licenses) {
  const visible = (licenses || []).filter((l) => l.status !== "refunded" && l.status !== "expired");
  const active = visible.find((l) => l.status === "active");
  const scheduledCount = visible.filter((l) => l.status === "scheduled").length;
  const availableCount = visible.filter((l) => l.status === "available").length;
  if (active) {
    const daysLeft = Math.ceil((new Date(active.end_date) - new Date(todayIso())) / 86400000);
    let text = `Active · ${daysLeft}d left`;
    if (scheduledCount === 0 && availableCount === 0 && daysLeft <= 7) return { text, color: "amber" };
    if (scheduledCount > 0) text += ` · ${scheduledCount} queued`;
    else if (availableCount > 0) text += ` · ${availableCount} spare`;
    return { text, color: "green" };
  }
  if (scheduledCount > 0) return { text: `${scheduledCount} scheduled`, color: "blue" };
  if (availableCount > 0) return { text: `${availableCount} available`, color: "amber" };
  return { text: "No license", color: "red" };
}

function ServiceEditor({ service, allServices, onChange, setError, tenant, locationName, locationCode, autoBuy, onAutoBuyHandled, startExpanded = false, statusInHeader = false }) {
  const [panel, setPanel] = useState(startExpanded ? "hours" : null); // null | "hours" | "licences"
  const [licMounted, setLicMounted] = useState(false); // keep the licences panel mounted once opened so a buy in progress survives switching tabs
  const [buyTrigger, setBuyTrigger] = useState(0);
  const [licenses, setLicenses] = useState([]);
  const [licensesLoaded, setLicensesLoaded] = useState(false);
  const [calendarRefresh, setCalendarRefresh] = useState(0);

  async function loadLicenses() {
    try { const r = await api.getServiceLicenses(service.id); setLicenses(r.licenses); } catch (err) { setError(err.message); }
    setLicensesLoaded(true);
  }
  useEffect(() => { loadLicenses(); }, [service.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = licenseSummary(licenses);
  const hasActiveLicense = licenses.some((l) => l.status === "active");
  // Hours only make sense while the service has a live or booked-in licence; Licences only once it has ever had one.
  const everHadLicence = licenses.some((l) => l.status !== "refunded");
  const showHoursBtn = licensesLoaded && licenses.some((l) => l.status === "active" || l.status === "scheduled");
  const showLicencesBtn = licensesLoaded && everHadLicence;
  useEffect(() => {
    if (licensesLoaded && ((panel === "hours" && !showHoursBtn) || (panel === "licences" && !showLicencesBtn && !buyTrigger))) setPanel(null);
  }, [licensesLoaded, showHoursBtn, showLicencesBtn]); // eslint-disable-line react-hooks/exhaustive-deps
  function openPanel(name) {
    if (name === "licences") setLicMounted(true);
    setPanel((cur) => (cur === name ? null : name));
  }
  function startBuy() {
    setLicMounted(true);
    setPanel("licences");
    setBuyTrigger((t) => t + 1);
  }
  useEffect(() => { if (autoBuy) { startBuy(); onAutoBuyHandled?.(); } }, [autoBuy]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentLic = currentLicenceOf(licenses);
  const modeText = service.mode === "queue" ? "Queue (walk-ins)" : service.mode === "appointment" ? `Appointments · ${service.slot_minutes} min slots` : `Queue and appointments · ${service.slot_minutes} min slots`;
  // Fake for now — there's no real WhatsApp Business number wired up yet, so the QR just
  // points at the same stand-in customer link the Setup tab shows, with the service tagged
  // on so the real version can route straight to it once WhatsApp is actually connected.
  function printServiceQR() {
    const CUSTOMER_APP_URL = import.meta.env.VITE_CUSTOMER_APP_URL || "http://localhost:5177";
    // The location code rides along in the QR so "Only joinable from the clinic" locations accept the scan.
    const link = `${CUSTOMER_APP_URL}/?t=${tenant.id}&s=${service.id}${locationCode ? `&c=${encodeURIComponent(locationCode)}` : ""}`;
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&color=1D5C8A&data=${encodeURIComponent(link)}`;
    const businessName = tenant?.business_name || "";
    const html = `<!doctype html><html><head><title>QR code — ${service.name}</title>
      <meta charset="utf-8" />
      <style>
        body{font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:40px auto;color:#1B1D1F;text-align:center;}
        .brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:28px;}
        .brand .mark{width:26px;height:26px;background:#1D5C8A;position:relative;display:inline-block;}
        .brand .mark::after{content:"";position:absolute;top:-4px;right:-4px;width:12px;height:12px;border-radius:50%;background:#C8690D;}
        .brand .word{font-size:18px;font-weight:700;letter-spacing:-0.02em;}
        .card{border:2px solid #1B1D1F;border-radius:14px;padding:32px;}
        .biz{font-size:13px;color:#5F615B;margin-bottom:2px;}
        .svc{font-size:20px;font-weight:700;margin-bottom:20px;}
        img{display:block;margin:0 auto;}
        .cta{font-size:15px;font-weight:600;margin-top:20px;}
        .sub{font-size:12px;color:#5F615B;margin-top:6px;}
        .foot{font-size:11px;color:#5F615B;margin-top:28px;}
      </style>
      </head><body>
        <div class="brand"><span class="mark"></span><span class="word">QBooker</span></div>
        <div class="card">
          <div class="biz">${businessName}</div>
          <div class="svc">${service.name}</div>
          <img src="${qrImg}" width="260" height="260" alt="QR code" />
          <div class="cta">📱 Scan to message us on WhatsApp</div>
          <div class="sub">Join the queue or book instantly — no app to download.</div>
        </div>
        <div class="foot">Powered by QBooker</div>
      </body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (w) w.onload = () => w.print();
  }

  return (
    <div className="svc-card" style={service.archived ? { opacity: 0.6 } : undefined}>
      <div className="svc-head">
        <div className="svc-title">
          <ServiceNameField key={service.id} service={service} onSaved={onChange} setError={setError} />
          <div className="svc-status">
            {service.archived && <span className="badge badge-amber">Archived</span>}
            {service.queue_paused && <span className="badge badge-red">Queue paused</span>}
            {!statusInHeader && <span className={`badge badge-${summary.color}`}>{summary.text}</span>}
            {currentLic && !statusInHeader && <span className="muted small">{licenceDetailText(currentLic)}</span>}
          </div>
          <div className="muted small">{modeText}</div>
        </div>
        {service.mode === "queue" && hasActiveLicense && (
          <button
            type="button"
            className={`btn-outline svc-pause${service.queue_paused ? " is-paused" : ""}`}
            aria-pressed={!!service.queue_paused}
            title="A live override on top of the scheduled hours — pause anytime without touching your calendar."
            aria-label={service.queue_paused ? `Resume queue for ${service.name}` : `Pause queue for ${service.name}`}
            onClick={async () => { try { await api.updateService(service.id, { queuePaused: !service.queue_paused }); onChange(); } catch (err) { setError(err.message); } }}
          >
            {service.queue_paused ? "Resume queue" : "Pause queue"}
          </button>
        )}
      </div>
      <div className="svc-actions">
        {showHoursBtn && <button type="button" className="btn-outline" aria-expanded={panel === "hours"} onClick={() => openPanel("hours")}>Hours</button>}
        {showLicencesBtn && <button type="button" className="btn-outline" aria-expanded={panel === "licences"} onClick={() => openPanel("licences")}>Licences</button>}
        <div className="svc-buy">
          <button type="button" className="btn" onClick={startBuy}>Buy a licence</button>
          <button type="button" className="btn-outline icon-btn" aria-label="Print QR code" title="Print QR code" onClick={printServiceQR}><QrIcon /></button>
          <button
            type="button" className="btn-outline icon-btn" aria-label="Archive service" title="Archive service"
            onClick={async () => {
              if (confirm(`Archive "${service.name}"? It'll move to the Audit tab, and you can unarchive it from there any time. Its license history is kept.`)) {
                try { await api.updateService(service.id, { archived: true }); onChange(); } catch (err) { setError(err.message); }
              }
            }}
          ><ArchiveIcon size={20} /></button>
        </div>
      </div>

      {licMounted && (
        <div className="svc-panel" hidden={panel !== "licences"}>
          <ServiceLicensesPanel
            service={service} allServices={allServices || []} setError={setError} locationName={locationName}
            onChanged={() => { loadLicenses(); onChange(); setCalendarRefresh((t) => t + 1); }}
            tenant={tenant} buyTrigger={buyTrigger} showBuyButton={false}
          />
        </div>
      )}
      {panel === "hours" && (
        <div className="svc-panel">
          <ServiceCalendar service={service} setError={setError} refreshToken={calendarRefresh} />
        </div>
      )}
    </div>
  );
}

// A license is bought for, and permanently bound to, this specific service. Available
// (bought, no dates) can be moved to another service or refunded within 90 days; Scheduled
// (dates assigned, maybe in the future) can have its dates changed or cleared; Active is
// fully locked. Shared by ServiceEditor and ServiceWizard (right after a service is created).
function ServiceLicensesPanel({ service, allServices, setError, onChanged, tenant, buyTrigger, showBuyButton = true, hideHeader = false, onBought, locationName }) {
  const [licenses, setLicenses] = useState([]);
  const [pricing, setPricing] = useState(null);
  const [buying, setBuying] = useState(false);
  // Buying is two steps, same shape as the signup wizard: pick the license type first,
  // then (only when it isn't free) confirm how it's paid for, before it's actually bought.
  const [buyStep, setBuyStep] = useState("plan");
  const [planId, setPlanId] = useState("week");
  const [customDays, setCustomDays] = useState(7);
  const [buyPay, setBuyPay] = useState(tenant?.payment_method === "invoice" ? "invoice" : "card");
  const [buyEmail, setBuyEmail] = useState(tenant?.invoice_email || "");
  const [buyPO, setBuyPO] = useState(tenant?.invoice_po || "");
  const [schedulingId, setSchedulingId] = useState(null);
  const [startDate, setStartDate] = useState(todayIso());
  const [movingId, setMovingId] = useState(null);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);
  // "Buy a license" lives in ServiceEditor's header (to the left of its Actions ⋯ menu);
  // it bumps buyTrigger to open the plan picker here.
  useEffect(() => { if (buyTrigger) { setBuying(true); setBuyStep("plan"); } }, [buyTrigger]);

  function selectedPrice() {
    if (!pricing) return 0;
    if (planId === "custom") return (Number(customDays) || 1) * pricing.customDailyRate;
    const onSale = pricing.sale?.active && pricing.sale[planId] != null;
    return Number(onSale ? pricing.sale[planId] : pricing[planId]) || 0;
  }

  async function load() {
    try { const r = await api.getServiceLicenses(service.id); setLicenses(r.licenses); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [service.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function buy() {
    try {
      const r = await api.buyServiceLicense(service.id, {
        planId, customDays: planId === "custom" ? customDays : undefined,
        paymentMethod: buyPay, invoiceEmail: buyPay === "invoice" ? buyEmail : undefined, invoicePO: buyPay === "invoice" ? buyPO : undefined,
      });
      setBuying(false);
      await load();
      onChanged?.();
      onBought?.(r.license);
    } catch (err) { setError(err.message); }
  }
  async function schedule(lic) {
    if (lic.status === "scheduled" && startDate !== lic.start_date) {
      if (!confirm("Change this license's dates? The hours and staffing already set on its old dates will move with it to the new dates.")) return;
    }
    try { await api.scheduleServiceLicense(service.id, lic.id, startDate); setSchedulingId(null); await load(); onChanged?.(); } catch (err) { setError(err.message); }
  }
  async function unschedule(lic) {
    if (!confirm("Unschedule this license? Its dates — and any hours already set across them — will be cleared, and it goes back to Available.")) return;
    try { await api.unscheduleServiceLicense(service.id, lic.id); await load(); onChanged?.(); } catch (err) { setError(err.message); }
  }
  async function move(lic, targetServiceId) {
    try { await api.moveServiceLicense(service.id, lic.id, targetServiceId); await load(); onChanged?.(); } catch (err) { setError(err.message); } finally { setMovingId(null); }
  }
  const visible = licenses.filter((l) => l.status !== "refunded");
  const otherServices = (allServices || []).filter((s) => s.id !== service.id && !s.archived);

  const planLabel = planId === "custom" ? "Custom" : planId.charAt(0).toUpperCase() + planId.slice(1);
  const price = selectedPrice();
  const PLAN_ROWS = [
    { id: "day", name: "Day", desc: "1 day" },
    { id: "week", name: "Week", desc: "7 days" },
    { id: "month", name: "Month", desc: "30 days" },
    { id: "custom", name: "Custom days", desc: "Pick the number of days" },
  ];
  const PAY_ROWS = [
    { id: "card", title: "Card", desc: "Pay by card — access is immediate. Card payments are handled securely by Stripe, so QBooker never stores your card details." },
    { id: "invoice", title: "Invoice", desc: "Added to your next invoice — access is immediate, billed per your invoice terms." },
    { id: "later", title: "Pay later", desc: "Get the license now and pay afterwards. It stays marked unpaid until you pay by card or choose invoice from your Account tab." },
  ];

  return (
    <div className="stack" style={{ gap: 8 }}>
      {!hideHeader && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: 14 }}>Licences</strong>
          {showBuyButton && !buying && <button className="btn-outline" onClick={() => { setBuying(true); setBuyStep("plan"); }}>Buy a licence</button>}
        </div>
      )}

      {buying && pricing && (
        <div className="buy-flow" role="region" aria-label="Buy a licence">
          <div className="buy-head">
            <button
              type="button" className="back-btn"
              aria-label={buyStep === "plan" ? "Cancel buying a licence" : "Back to plan"}
              onClick={() => (buyStep === "plan" ? setBuying(false) : setBuyStep("plan"))}
            ><BackIcon /></button>
            <div className="title">Buy a licence</div>
          </div>
          <div className="buy-progress">
            <div className="bars" aria-hidden="true">
              <span className="on" /><span className="on" /><span className={buyStep === "payment" ? "on" : ""} />
            </div>
            <div className="labels">
              <span>Service</span>
              <span className={buyStep === "plan" ? "cur" : ""}>Plan</span>
              <span className={buyStep === "payment" ? "cur" : ""}>Payment</span>
            </div>
            <div className="sr-only" role="status">Step {buyStep === "plan" ? 2 : 3} of 3: {buyStep === "plan" ? "Plan" : "Payment"}</div>
          </div>

          <div className="buy-body">
            {buyStep === "plan" && (
              <>
                <div>
                  <h2>Choose a plan</h2>
                  <div className="muted" style={{ fontSize: 14, marginTop: 2 }}>{service.name}{locationName ? ` at ${locationName}` : ""}</div>
                </div>
                <div className="stack" style={{ gap: 12 }} role="radiogroup" aria-label="Licence plan">
                  {PLAN_ROWS.map((row) => {
                    const onSale = row.id !== "custom" && pricing.sale?.active && pricing.sale[row.id] != null;
                    const p = row.id === "custom" ? pricing.customDailyRate : (onSale ? pricing.sale[row.id] : pricing[row.id]);
                    return (
                      <button key={row.id} type="button" role="radio" aria-checked={planId === row.id} className="plan-row" onClick={() => setPlanId(row.id)}>
                        <span className="plan-dot" aria-hidden="true" />
                        <span className="plan-text"><span className="plan-name">{row.name}</span><span className="plan-desc">{row.desc}</span></span>
                        <span className="plan-price">
                          <b>{Number(p) > 0 ? `${exMoney(p)}${row.id === "custom" ? "/day" : ""}` : "Free"}</b>
                          {Number(p) > 0 && <span>({exMoney(incVat(p))} inc VAT)</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {planId === "custom" && (
                  <label className="field" style={{ maxWidth: 200 }}>
                    <span className="field-label">Number of days</span>
                    <input className="input" type="number" inputMode="numeric" min={1} value={customDays} onChange={(e) => setCustomDays(Math.max(1, Number(e.target.value) || 1))} />
                  </label>
                )}
              </>
            )}

            {buyStep === "payment" && (
              <>
                <div>
                  <h2>How will you pay?</h2>
                  <div className="muted" style={{ fontSize: 14, marginTop: 2 }}>{planLabel} licence{planId === "custom" ? ` (${customDays} day${Number(customDays) === 1 ? "" : "s"})` : ""} — {priceText(price)}</div>
                </div>
                <div className="stack" style={{ gap: 12 }} role="radiogroup" aria-label="Payment method">
                  {PAY_ROWS.map((row) => (
                    <button key={row.id} type="button" role="radio" aria-checked={buyPay === row.id} className="payment-option" onClick={() => setBuyPay(row.id)}>
                      <span className="payment-option-title">{row.title}</span>
                      <span className="payment-option-desc">{row.desc}</span>
                    </button>
                  ))}
                </div>
                {buyPay === "invoice" && (
                  <div className="form-grid">
                    <label className="field">
                      <span className="field-label">Billing email</span>
                      <input className="input" type="email" value={buyEmail} onChange={(e) => setBuyEmail(e.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">PO / reference number</span>
                      <input className="input" value={buyPO} onChange={(e) => setBuyPO(e.target.value)} />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="buy-bar">
            <div className="total">
              <div className="k">Total</div>
              <div className="v">{price > 0 ? <>{exMoney(price)} <small>({exMoney(incVat(price))} inc VAT)</small></> : "Free"}</div>
            </div>
            {buyStep === "plan" ? (
              <>
                <button type="button" className="btn-outline hide-phone" onClick={() => setBuying(false)}>Cancel</button>
                <button type="button" className="btn btn-accent" onClick={() => (price > 0 ? setBuyStep("payment") : buy())}>
                  {price > 0 ? "Continue" : "Buy — free"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-outline hide-phone" onClick={() => setBuyStep("plan")}>Back</button>
                <button type="button" className="btn btn-accent" disabled={buyPay === "invoice" && !buyPO.trim()} onClick={buy}>Confirm &amp; buy</button>
              </>
            )}
          </div>
        </div>
      )}

      {visible.length === 0 && !buying && <div className="muted small">No licences yet — buy one to make this service bookable.</div>}

      <div>
        {visible.map((lic) => {
          const meta = LICENSE_STATUS_META[lic.status];
          const showMenu = lic.status === "scheduled" || movingId === lic.id;
          return (
            <div key={lic.id} className="lic-card">
              <div className="lic-main">
                <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                <strong style={{ fontSize: 15 }}>{lic.plan_label}</strong>
                {lic.paid === false && lic.status !== "refunded" && <span className="badge badge-amber">Invoice — awaiting payment</span>}
              </div>
              {lic.start_date && <div className="muted small">{formatDateDisplay(lic.start_date)} to {formatDateDisplay(lic.end_date)}</div>}
              <div className="lic-actions">
                {lic.status === "available" && schedulingId !== lic.id && (
                  <button className="btn-outline" onClick={() => { setSchedulingId(lic.id); setStartDate(lic.start_date || todayIso()); }}>
                    Assign dates
                  </button>
                )}
                {showMenu && (movingId === lic.id ? (
                  <select aria-label="Move licence to another service" defaultValue="" onChange={(e) => { if (e.target.value) move(lic, e.target.value); }}>
                    <option value="" disabled>Move to…</option>
                    {otherServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : (
                  <MoreMenu
                    label="Licence actions"
                    items={[
                      lic.status === "scheduled" && { label: "Change dates", onClick: () => { setSchedulingId(lic.id); setStartDate(lic.start_date || todayIso()); } },
                      lic.status === "scheduled" && { label: "Unschedule", onClick: () => unschedule(lic) },
                      lic.status === "available" && otherServices.length > 0 && { label: "Move License", onClick: () => setMovingId(lic.id) },
                    ]}
                  />
                ))}
              </div>
              {schedulingId === lic.id && (
                <div className="stack" style={{ gap: 8 }}>
                  <label className="field" style={{ maxWidth: 220 }}>
                    <span className="field-label">Start date</span>
                    <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </label>
                  <span className="muted small">Ends {formatDateDisplay(addDaysIso(startDate, lic.plan_days - 1))}</span>
                  {startDate === todayIso() && (
                    <div className="notice-info" role="note" style={{ background: "#EEF5FA", border: "1px solid #BBD3E4", padding: "10px 12px", fontSize: 14, lineHeight: "20px", maxWidth: 420 }}>
                      Starting today uses a full day of this licence, even though part of today has already passed. You can open hours from now onwards.
                    </div>
                  )}
                  <div className="form-actions">
                    <button className="btn" onClick={() => schedule(lic)}>Confirm</button>
                    <button className="btn-outline" onClick={() => setSchedulingId(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Shared by ServiceEditor (post-setup editing) and ServiceWizard (step 2, right after creation).
// Booking + walk-in staff can never exceed total staff. When total staff drops, trims walk-in
// first, then booking, so a deliberate booking count isn't silently clobbered unless it has to be.
function clampStaffSplit(staff, booking, walkIn) {
  let b = Math.max(0, Math.min(booking, staff));
  let w = Math.max(0, Math.min(walkIn, staff - b));
  return { booking: b, walkIn: w };
}

function ServiceCalendar({ service, setError, refreshToken }) {
  // No day is selected until the admin picks one on the calendar — picking is only
  // possible for a day actually covered by a license (see the calendar button's
  // `inWindow` guard below), so the hours panel never opens onto an uncovered day.
  const [selectedDate, setSelectedDate] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(firstOfMonth(todayIso()));
  const [monthConfigs, setMonthConfigs] = useState({});
  const [windows, setWindows] = useState([]); // this service's scheduled/active license windows — gaps allowed, never overlapping
  const [draftHours, setDraftHours] = useState([]);
  const [staffCount, setStaffCount] = useState(2);
  const [bookingStaffCount, setBookingStaffCount] = useState(1);
  const [walkInStaffCount, setWalkInStaffCount] = useState(1);
  const [saveStatus, setSaveStatus] = useState(""); // "", "saving", "saved", "error"
  const [staffError, setStaffError] = useState(""); // server rejection of a staff/hours change, shown beside the staff controls

  const paintingRef = useRef(false);
  const paintModeRef = useRef(true);
  const staffCountRef = useRef(2);
  const bookingRef = useRef(1);
  const walkInRef = useRef(1);
  const saveTimeoutRef = useRef(null);
  const savedIndicatorRef = useRef(null);

  useEffect(() => { staffCountRef.current = staffCount; }, [staffCount]);
  useEffect(() => { bookingRef.current = bookingStaffCount; }, [bookingStaffCount]);
  useEffect(() => { walkInRef.current = walkInStaffCount; }, [walkInStaffCount]);

  // Only resets drag state on mouse release — the actual save no longer depends on
  // catching this event, so a missed mouseup can no longer cause a silently-lost save.
  useEffect(() => {
    function onUp() { paintingRef.current = false; }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  async function loadMonth(monthStart) {
    const monthEnd = addDaysIso(addMonthsIso(monthStart, 1), -1);
    try {
      const r = await api.getDailyConfig(service.id, monthStart, monthEnd);
      const map = {};
      r.dailyConfig.forEach((d) => { map[d.date] = d; });
      setMonthConfigs(map);
      setWindows(r.windows || []);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadMonth(calendarMonth); }, [calendarMonth]); // eslint-disable-line react-hooks/exhaustive-deps
  // A license action elsewhere (unschedule, move, refund, buy, change dates) can change
  // which days this service is actually licensed for — re-fetch this month's windows so
  // the calendar doesn't keep showing a day as selected/editable that's no longer covered.
  useEffect(() => { if (refreshToken) loadMonth(calendarMonth); }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  function isWithinAnyWindow(d) {
    return windows.some((w) => d >= w.start && d <= w.end);
  }
  const overallStart = windows.length ? windows.map((w) => w.start).sort()[0] : null;
  const overallEnd = windows.length ? windows.map((w) => w.end).sort().slice(-1)[0] : null;

  // Whenever there's no valid day selected — opening the calendar fresh, or the
  // previously-selected day just fell outside a window that changed (e.g. it was
  // unscheduled) — jump straight to a sensible default instead of leaving it on a
  // blank "pick a day" state the admin has to act on first: today's date when this
  // service is currently live (today falls inside one of its windows), otherwise the
  // first day of the earliest scheduled/active window — switching the visible month
  // to match either way.
  useEffect(() => {
    if (selectedDate && isWithinAnyWindow(selectedDate)) return;
    const target = isWithinAnyWindow(todayIso()) ? todayIso() : overallStart;
    if (target) {
      setSelectedDate(target);
      const m = firstOfMonth(target);
      if (m !== calendarMonth) setCalendarMonth(m);
    } else if (selectedDate) {
      setSelectedDate(null);
    }
  }, [windows]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedDate) return;
    const entry = monthConfigs[selectedDate];
    setDraftHours(entry?.hours || []);
    setStaffCount(entry?.staff_count ?? 2);
    setBookingStaffCount(entry?.booking_staff_count ?? 1);
    setWalkInStaffCount(entry?.walkin_staff_count ?? 1);
  }, [selectedDate, monthConfigs]);
  useEffect(() => { setStaffError(""); }, [selectedDate]);

  const selectedIsPast = !!selectedDate && isDatePastClient(selectedDate);
  const selectedIsToday = !!selectedDate && selectedDate === todayIso();
  // A day is "live" once it is today or earlier. Live days: no Set 9-5 / Clear day, started hours are frozen,
  // staff can go up any time but only down while nothing is booked or queued (the server enforces the same).
  const selectedIsLive = !!selectedDate && selectedDate <= todayIso();
  const currentMinutes = nowMinutes();

  function isBlockEditable(hourMin) {
    if (selectedIsPast) return false;
    if (selectedIsToday && hourMin < currentMinutes) return false;
    return true;
  }

  // Saves shortly after painting pauses — triggered directly from the toggle itself
  // (not a separate global listener), so there's no dependency on catching the right
  // browser event, and it behaves identically for mouse and touch.
  function persistHours(hoursToSave, dateToSave) {
    setSaveStatus("saving");
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    if (savedIndicatorRef.current) clearTimeout(savedIndicatorRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await api.putDailyConfig(service.id, { date: dateToSave, hours: hoursToSave, staffCount: staffCountRef.current, bookingStaffCount: bookingRef.current, walkInStaffCount: walkInRef.current, nowMinutes: nowMinutes() });
        setMonthConfigs((prev) => ({ ...prev, [dateToSave]: { date: dateToSave, hours: hoursToSave, staff_count: staffCountRef.current, booking_staff_count: bookingRef.current, walkin_staff_count: walkInRef.current } }));
        setSaveStatus("saved");
        savedIndicatorRef.current = setTimeout(() => setSaveStatus(""), 1500);
      } catch (err) {
        setError(err.message);
        setSaveStatus("error");
        loadMonth(calendarMonth); // roll the grid back to what the server actually has
      }
    }, 350);
  }

  function applyHour(hourMin, open) {
    setDraftHours((prev) => {
      const has = prev.includes(hourMin);
      let next = prev;
      if (open && !has) next = [...prev, hourMin].sort((a, b) => a - b);
      else if (!open && has) next = prev.filter((h) => h !== hourMin);
      if (next !== prev) persistHours(next, selectedDate);
      return next;
    });
  }
  function beginPaint(hourMin) {
    if (!isBlockEditable(hourMin)) return;
    const mode = !draftHours.includes(hourMin);
    paintingRef.current = true;
    paintModeRef.current = mode;
    applyHour(hourMin, mode);
  }
  function continuePaint(hourMin) {
    if (!paintingRef.current || !isBlockEditable(hourMin)) return;
    applyHour(hourMin, paintModeRef.current);
  }

  async function saveNow(patch) {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const hours = patch.hours ?? draftHours;
    const nextStaff = patch.staffCount ?? staffCount;
    const nextBooking = patch.bookingStaffCount ?? bookingStaffCount;
    const nextWalkIn = patch.walkInStaffCount ?? walkInStaffCount;
    if (patch.hours) setDraftHours(patch.hours);
    if (patch.staffCount !== undefined) setStaffCount(patch.staffCount);
    if (patch.bookingStaffCount !== undefined) setBookingStaffCount(patch.bookingStaffCount);
    if (patch.walkInStaffCount !== undefined) setWalkInStaffCount(patch.walkInStaffCount);
    setSaveStatus("saving");
    setStaffError("");
    try {
      await api.putDailyConfig(service.id, { date: selectedDate, hours, staffCount: nextStaff, bookingStaffCount: nextBooking, walkInStaffCount: nextWalkIn, nowMinutes: nowMinutes() });
      setMonthConfigs((prev) => ({ ...prev, [selectedDate]: { date: selectedDate, hours, staff_count: nextStaff, booking_staff_count: nextBooking, walkin_staff_count: nextWalkIn } }));
      setSaveStatus("saved");
      if (savedIndicatorRef.current) clearTimeout(savedIndicatorRef.current);
      savedIndicatorRef.current = setTimeout(() => setSaveStatus(""), 1500);
    } catch (err) {
      setStaffError(err.message);
      setSaveStatus("error");
      loadMonth(calendarMonth); // reload the saved values so the inputs snap back to what the server has
    }
  }

  // For today, quick-fill/clear only touch hours from now onward — whatever was already
  // set for earlier today (already offered/used) is left exactly as it was.
  function fillNineToFive() {
    const target = [];
    for (let h = 540; h < 1020; h += 30) target.push(h);
    if (selectedIsToday) {
      const already = draftHours.filter((h) => h < currentMinutes);
      const upcoming = target.filter((h) => h >= currentMinutes);
      saveNow({ hours: [...new Set([...already, ...upcoming])].sort((a, b) => a - b) });
    } else {
      saveNow({ hours: target });
    }
  }
  function clearDay() {
    if (selectedIsToday) {
      saveNow({ hours: draftHours.filter((h) => h < currentMinutes) });
    } else {
      saveNow({ hours: [] });
    }
  }

  async function copyToWeek() {
    const idx = weekdayIndex(selectedDate);
    const monday = addDaysIso(selectedDate, -idx);
    const targets = Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i)).filter((d) => d !== selectedDate && d > todayIso());
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }
  async function copyToMonth() {
    const fm = firstOfMonth(selectedDate);
    const n = daysInMonthOf(fm);
    const targets = Array.from({ length: n }, (_, i) => addDaysIso(fm, i)).filter((d) => d !== selectedDate && d > todayIso());
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }
  async function copyToWholePeriod() {
    if (!windows.length) return;
    const targets = [];
    for (const w of windows) {
      let d = w.start;
      let guard = 0;
      while (d <= w.end && guard < 400) { if (d !== selectedDate && d > todayIso()) targets.push(d); d = addDaysIso(d, 1); guard++; }
    }
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }

  const calendarWeeks = buildCalendarWeeks(calendarMonth);

  // Nothing to schedule hours against yet — don't show an empty calendar control.
  if (!windows.length) {
    return <div className="muted" style={{ fontSize: 13 }}>No scheduled dates yet — assign a license to the calendar above to set opening hours.</div>;
  }

  return (
    <div className="stack">
      <div className="cal-layout">
        <div className="cal-card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <button className="btn-outline icon-btn" aria-label="Previous month" disabled={overallStart && calendarMonth <= firstOfMonth(overallStart)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, -1))}>‹</button>
            <strong style={{ fontSize: 14 }}>{monthLabel(calendarMonth)}</strong>
            <button className="btn-outline icon-btn" aria-label="Next month" disabled={overallEnd && calendarMonth >= firstOfMonth(overallEnd)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, 1))}>›</button>
          </div>
          <table>
            <thead><tr>{DAY_LETTERS.map((d, i) => <th key={i}>{d}</th>)}</tr></thead>
            <tbody>
              {calendarWeeks.map((week, wi) => (
                <tr key={wi}>
                  {week.map((d, di) => {
                    if (!d) return <td key={di} />;
                    const inWindow = isWithinAnyWindow(d);
                    const past = isDatePastClient(d);
                    const count = monthConfigs[d]?.hours?.length || 0;
                    const isSelected = d === selectedDate;
                    const isToday = d === todayIso();
                    return (
                      <td key={di}>
                        <button
                          type="button"
                          className={`cal-day${isSelected ? " sel" : count > 0 ? " has" : ""}${isToday ? " today" : ""}`}
                          onClick={() => inWindow && setSelectedDate(d)}
                          disabled={!inWindow}
                          aria-pressed={isSelected}
                          aria-label={`${formatDateDisplay(d)}${isToday ? ", today" : ""}${!inWindow ? ", not covered by a licence" : ""}`}
                          title={!inWindow ? "Not covered by a license for this service" : past ? "In the past — view only" : isToday ? "Today — you can still set hours for the rest of the day" : `${count} half-hour block(s) open`}
                        >
                          {Number(d.slice(8, 10))}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack grow">
          {selectedDate && (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong style={{ fontSize: 14 }}>Hours for {formatDateDisplay(selectedDate)}</strong>
                <span role="status" aria-live="polite">
                  {saveStatus === "saving" && <span className="muted small">Saving…</span>}
                  {saveStatus === "saved" && <span className="small" style={{ color: "#2F6F4E" }}>✓ Saved</span>}
                  {saveStatus === "error" && <span className="small" style={{ color: "#B3261E" }}>Save failed</span>}
                </span>
              </div>
              <div className="hour-grid">
                {GRID_HOURS.map((h) => {
                  const open = draftHours.includes(h);
                  const editable = isBlockEditable(h);
                  return (
                    <button
                      key={h}
                      type="button"
                      onMouseDown={() => beginPaint(h)}
                      onMouseEnter={() => continuePaint(h)}
                      onClick={(e) => { if (e.detail === 0 && editable) applyHour(h, !open); }} // keyboard activation only; pointer input is handled on mousedown so dragging can paint a range
                      className={`hour-chip${open ? " open" : ""}`}
                      aria-pressed={open}
                      disabled={!editable}
                      title={!editable && selectedIsToday ? "Already passed" : undefined}
                    >
                      {formatTime(h)}
                    </button>
                  );
                })}
              </div>

              {!selectedIsLive && (
                <div className="wrap">
                  <span className="muted small" style={{ minWidth: 68 }}>This day:</span>
                  <button className="btn-outline" onClick={fillNineToFive}>Set 9–5</button>
                  <button className="btn-outline" onClick={clearDay}>Clear day</button>
                </div>
              )}

              <div className="staff-inputs">
                <label className="muted small" htmlFor={`staff-${service.id}`} style={{ minWidth: 68 }}>Staff:</label>
                <input
                  id={`staff-${service.id}`}
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  disabled={selectedIsPast}
                  value={staffCount}
                  onChange={(e) => {
                    const nextStaff = Math.max(1, Number(e.target.value) || 1);
                    const { booking: nextBooking, walkIn: nextWalkIn } = clampStaffSplit(nextStaff, bookingStaffCount, walkInStaffCount);
                    saveNow({ staffCount: nextStaff, bookingStaffCount: nextBooking, walkInStaffCount: nextWalkIn });
                  }}
                />
                {service.mode === "hybrid" && (
                  <>
                    <label className="muted small" htmlFor={`book-${service.id}`}>On bookings:</label>
                    <input
                      id={`book-${service.id}`}
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={selectedIsPast}
                      value={bookingStaffCount}
                      onChange={(e) => {
                        const nextBooking = Math.max(0, Math.min(Number(e.target.value) || 0, staffCount));
                        const nextWalkIn = Math.min(walkInStaffCount, staffCount - nextBooking);
                        saveNow({ bookingStaffCount: nextBooking, walkInStaffCount: nextWalkIn });
                      }}
                    />
                    <label className="muted small" htmlFor={`walk-${service.id}`}>On walk-ins:</label>
                    <input
                      id={`walk-${service.id}`}
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={selectedIsPast}
                      value={walkInStaffCount}
                      onChange={(e) => {
                        const nextWalkIn = Math.max(0, Math.min(Number(e.target.value) || 0, staffCount));
                        const nextBooking = Math.min(bookingStaffCount, staffCount - nextWalkIn);
                        saveNow({ walkInStaffCount: nextWalkIn, bookingStaffCount: nextBooking });
                      }}
                    />
                  </>
                )}
              </div>
              {staffError && <div className="staff-error" role="alert">{staffError}</div>}

              {!selectedIsPast && (
                <div className="wrap">
                  <span className="muted small" style={{ minWidth: 68 }}>Copy to:</span>
                  <button className="btn-outline" onClick={copyToWeek}>Rest of week</button>
                  <button className="btn-outline" onClick={copyToMonth}>Rest of month</button>
                  <button className="btn-outline" onClick={copyToWholePeriod}>All licensed dates</button>
                </div>
              )}

            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SERVICE_MODE_INFO = [
  { id: "queue", label: "Queue", text: "Walk-ins only. Customers join a live queue and get called forward in order — no fixed appointment times." },
  { id: "appointment", label: "Appointment", text: "Bookable time slots only. Customers pick a specific time in advance — no walk-ins." },
  { id: "hybrid", label: "Hybrid", text: "Both at once. Some staff take walk-ins while others take bookings, at the same time." },
];

function ServiceWizard({ locationId, locationName, allServices, onDone, onAdded, onCancel, setError, tenant }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [creating, setCreating] = useState(false);
  const [createdService, setCreatedService] = useState(null);

  const needsSlotLength = mode === "appointment" || mode === "hybrid";

  function addAnother() {
    onAdded?.();
    setStep(1);
    setName("");
    setMode("hybrid");
    setSlotMinutes(15);
    setCreatedService(null);
  }

  async function next() {
    setCreating(true);
    try {
      const r = await api.addService(name, locationId);
      const updated = await api.updateService(r.service.id, { mode, slotMinutes: needsSlotLength ? slotMinutes : 15 });
      setCreatedService(updated.service);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (step === 1) {
    return (
      <div className="card stack" style={{ background: "var(--accent-weak)", border: "1px solid var(--ink)" }}>
        <h3>New service <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>— step 1 of 3</span></h3>
        <label className="field">
          <span className="field-label">Service name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="stack" role="radiogroup" aria-label="Service type">
          {SERVICE_MODE_INFO.map((m) => (
            <label key={m.id} className="card row" style={{ cursor: "pointer", alignItems: "flex-start", minHeight: 64, background: mode === m.id ? "#fff" : "transparent", borderColor: mode === m.id ? "var(--ink)" : undefined }}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} style={{ marginTop: 4, width: 20, height: 20, flex: "none" }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{m.label}</div>
                <div className="muted small">{m.text}</div>
              </div>
            </label>
          ))}
        </div>
        {needsSlotLength && (
          <label className="field" style={{ maxWidth: 220 }}>
            <span className="field-label">Slot length</span>
            <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
              {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
        )}
        <div className="muted small">The name, type, slot length, and location can't be changed after this step — delete and recreate the service if you need to change them later.</div>
        <div className="form-actions">
          <button className="btn" disabled={!name.trim() || creating} onClick={next}>{creating ? "Creating…" : "Next: buy a license →"}</button>
          <button className="btn-outline" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="card stack" style={{ background: "var(--accent-weak)", border: "1px solid var(--ink)" }}>
        <h3>New service <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>— step 2 of 2: buy a license for "{createdService.name}"</span></h3>
        <div className="muted small">This license is bound to this service. Assign it to calendar dates any time from the service's own panel.</div>
        <ServiceLicensesPanel
          service={createdService} locationName={locationName} allServices={allServices || []} setError={setError}
          onChanged={() => {}} tenant={tenant} buyTrigger={1} hideHeader
          onBought={() => setStep(3)}
        />
      </div>
    );
  }

  return (
    <div className="card stack" style={{ background: "var(--accent-weak)", border: "1px solid var(--ink)" }}>
      <h3>"{createdService.name}" is ready</h3>
      <div className="muted small">License bought — assign it to calendar dates any time from the service's own panel.</div>
      <div className="form-actions">
        <button className="btn-outline" onClick={addAnother}>+ Add another service</button>
        <button className="btn" onClick={() => onDone(createdService)}>Done</button>
      </div>
    </div>
  );
}
