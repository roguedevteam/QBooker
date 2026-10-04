import { useState, useEffect, useRef } from "react";
import { api, setToken, hasToken } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

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
function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      className="btn-outline"
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      style={{ padding: "3px 6px", lineHeight: 0 }}
      onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
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
        <rect x="2" y="2" width="40" height="40" fill="var(--blue)" />
        <circle cx="42" cy="22" r="7" fill="var(--accent)" />
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
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 10 }}>
          <Logo />
          {tenant && <span className="muted" style={{ fontSize: 13 }}>— {tenant.business_name}</span>}
        </div>
        <div className="row">
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {formatDateDisplay(todayIso())}</span>}
          {tenant && <span className="muted" style={{ fontSize: 12 }}>{tenant.status === "pending" ? "Payment pending" : "Active"}</span>}
          {tenant ? (
            <button className="btn-outline" onClick={doSignOut}>Sign out</button>
          ) : (
            <a href={import.meta.env.VITE_MARKETING_URL || "http://localhost:5175"} style={{ color: "var(--brand)", fontSize: 13, fontWeight: 600 }}>New here? Sign up →</a>
          )}
        </div>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#B3261E", color: "#B3261E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "admin-login" && <AdminLogin onSignedIn={(t) => { setTenant(t); setScreen("admin"); }} setError={setError} />}
      {screen === "admin" && tenant && <AdminDashboard tenant={tenant} onTenantChange={setTenant} onAccountDeleted={doSignOut} setError={setError} />}
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
    <div className="narrow card stack">
      <h3>Admin sign-in</h3>
      {step === "email" && (
        <>
          <input className="input" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" onClick={sendCode}>Send login code</button>
        </>
      )}
      {step === "otp" && (
        <>
          <div className="muted">We've emailed a code (demo: <strong>{demoOtp}</strong>)</div>
          <input className="input" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn" onClick={verify}>Verify &amp; sign in</button>
        </>
      )}
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

function AdminDashboard({ tenant, onTenantChange, onAccountDeleted, setError }) {
  const [tab, setTab] = useState("dashboard");
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [locationOverrides, setLocationOverrides] = useState({}); // { [locId]: boolean } — explicit open/close, overrides the default
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

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="wrap">
          {["dashboard", "locations", "profile", "audit"].map((t) => (
            <button key={t} className={tab === t ? "btn" : "btn-outline"} onClick={() => { setTab(t); if (t === "dashboard") refreshQueue(); if (t === "audit") refreshAudit(); if (t === "profile") refreshLicenses(); }}>{t === "profile" ? "account" : t}</button>
          ))}
        </div>
        {tab === "locations" && (
          <div className="row">
            {!addingLocation && <button className="btn" onClick={() => setAddingLocation(true)}>+ Add location</button>}
          </div>
        )}
      </div>

      {tab === "locations" && (
        <div className="stack">
          <PendingPaymentBanner tenant={tenant} />

          {addingLocation && (
            <div className="card row">
              <input className="input" autoFocus placeholder="Location name" value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
              <button className="btn" disabled={!newLocationName.trim()} onClick={async () => { try { await api.addLocation(newLocationName.trim()); setNewLocationName(""); setAddingLocation(false); refreshCore(); } catch (err) { setError(err.message); } }}>Add</button>
              <button className="btn-outline" onClick={() => { setAddingLocation(false); setNewLocationName(""); }}>Cancel</button>
            </div>
          )}

          {visibleLocations.map((loc) => {
            const locServices = visibleServices.filter((s) => s.location_id === loc.id);
            const soleLocation = visibleLocations.length === 1;
            // Defaults open for the only location you have, or a location with just one
            // service — nothing to pick between, so there's no reason to make them click in.
            // An explicit click always overrides that default, either way.
            const defaultOpen = soleLocation || locServices.length === 1;
            const override = locationOverrides[loc.id];
            const isOpen = override !== undefined ? override : defaultOpen;
            const addingHere = addingServiceFor === loc.id;
            return (
              <div key={loc.id} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <input
                      className="input" style={{ maxWidth: 180, fontWeight: 600 }} defaultValue={loc.name}
                      onBlur={async (e) => { const v = e.target.value.trim(); if (v && v !== loc.name) { await api.updateLocation(loc.id, { name: v }); refreshCore(); } else { e.target.value = loc.name; } }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                    />
                    <code style={{ fontSize: 12, letterSpacing: 1, background: "#F7F7F4", padding: "2px 8px", borderRadius: 4 }}>{loc.staff_access_code || "—"}</code>
                    <CopyButton value={loc.staff_access_code} />
                    <span className="muted" style={{ fontSize: 12 }}>{locServices.length} service{locServices.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="row">
                    {isOpen && (
                      <>
                        <button className="btn-outline" onClick={() => { setAddingServiceFor(loc.id); setLocationOverrides((prev) => ({ ...prev, [loc.id]: true })); }}>+ Add service</button>
                        <button
                          className="btn-outline row"
                          style={{ gap: 4 }}
                          title="Archive location"
                          aria-label="Archive location"
                          onClick={async () => {
                            if (confirm(`Archive "${loc.name}"? It'll move to the Audit tab, and you can unarchive it from there any time. Its services and license history are kept.`)) {
                              await api.archiveLocation(loc.id);
                              refreshCore();
                            }
                          }}
                        >
                          <ArchiveIcon /> Archive
                        </button>
                      </>
                    )}
                    <button className="btn-outline" onClick={() => setLocationOverrides((prev) => ({ ...prev, [loc.id]: !isOpen }))} title={isOpen ? "Collapse" : "Expand"}>
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </div>
                </div>

                {addingHere && (
                  <ServiceWizard
                    locationId={loc.id}
                    allServices={services}
                    setError={setError}
                    onCancel={() => setAddingServiceFor(null)}
                    onAdded={refreshCore}
                    onDone={() => { setAddingServiceFor(null); refreshCore(); }}
                    tenant={tenant}
                  />
                )}

                {isOpen && (
                  <div className="stack" style={{ paddingLeft: 20, borderLeft: "2px solid #DEDDD6" }}>
                    {locServices.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No services here yet — click "Add service" above.</div>}
                    {locServices.map((s) => <ServiceEditor key={s.id} service={s} allServices={services} onChange={refreshCore} setError={setError} tenant={tenant} />)}
                  </div>
                )}
              </div>
            );
          })}
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
      {tab === "shop" && <ShopTab tenant={tenant} locations={locations} />}

      {tab === "dashboard" && (
        <div className="stack">
          {setupPercent < 100 && (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Finish setting up your account</div>
                <span className="muted" style={{ fontSize: 12 }}>{setupPercent}% complete</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "#EAE9E3", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${setupPercent}%`, background: "var(--brand)", borderRadius: 3 }} />
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {setupTasks.filter((t) => !t.done).map((t) => (
                  <div key={t.key} className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13 }}>{t.label}</span>
                    <div className="row">
                      <button className="btn-outline" onClick={t.go}>{t.cta}</button>
                      <button
                        className="btn-outline"
                        title="Dismiss — won't be shown again"
                        style={{ border: "none", padding: "0 4px", background: "transparent" }}
                        onClick={() => dismissSetupTask(t.key)}
                      >✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn-outline" onClick={refreshQueue}>Refresh</button></div>
          <div className="wrap">
            <div className="card">{visibleLocations.length}<div className="muted" style={{ fontSize: 11 }}>Location{visibleLocations.length === 1 ? "" : "s"}</div></div>
            <div className="card">{services.filter((s) => !s.archived).length}<div className="muted" style={{ fontSize: 11 }}>Active service{services.length === 1 ? "" : "s"}</div></div>
          </div>
          {stats && (
            <div className="wrap">
              <div className="card">{stats.waiting}<div className="muted" style={{ fontSize: 11 }}>Waiting</div></div>
              <div className="card">{stats.booked}<div className="muted" style={{ fontSize: 11 }}>Booked</div></div>
              <div className="card">{stats.seen}<div className="muted" style={{ fontSize: 11 }}>Seen today</div></div>
              <div className="card">{stats.no_show}<div className="muted" style={{ fontSize: 11 }}>No-show</div></div>
              <div className="card">{stats.cancelled}<div className="muted" style={{ fontSize: 11 }}>Cancelled</div></div>
            </div>
          )}
          <div className="card">
            <table>
              <thead><tr><th>Ticket</th><th>Service</th><th>Type/time</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {tickets.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 16 }}>No tickets today.</td></tr>}
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td>{t.ticket_number}</td>
                    <td>{services.find((s) => s.id === t.service_id)?.name || "—"}</td>
                    <td>{t.type === "booked" ? formatTime(t.slot_time) : "Walk-in"}</td>
                    <td><span className={`badge badge-${t.status === "seen" ? "green" : t.status === "cancelled" || t.status === "no_show" ? "red" : "blue"}`}>{t.status}</span></td>
                    <td className="row">
                      <select onChange={async (e) => { if (e.target.value) { await api.updateTicket(t.id, { serviceId: e.target.value }); refreshQueue(); } }}>
                        <option value="">Move to…</option>
                        {services.filter((s) => s.id !== t.service_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <button className="btn-outline" onClick={async () => { await api.deleteTicket(t.id); refreshQueue(); }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "audit" && (
        <div className="stack">
          {archivedLocations.length > 0 && (
            <div className="card stack">
              <div style={{ fontSize: 13, fontWeight: 600 }}>Archived locations ({archivedLocations.length})</div>
              {archivedLocations.map((loc) => (
                <div key={loc.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13 }}>{loc.name}</span>
                  <button className="btn-outline" onClick={async () => { try { await api.unarchiveLocation(loc.id); refreshCore(); } catch (err) { setError(err.message); } }}>Unarchive</button>
                </div>
              ))}
            </div>
          )}
          {archivedServices.length > 0 && (
            <div className="card stack">
              <div style={{ fontSize: 13, fontWeight: 600 }}>Archived services ({archivedServices.length})</div>
              {archivedServices.map((s) => {
                const loc = locations.find((l) => l.id === s.location_id);
                return (
                  <div key={s.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13 }}>{s.name} <span className="muted">— {loc?.name || "—"}</span></span>
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
          <div className="card stack">
            {auditLog.length === 0 && <div className="muted">No activity yet.</div>}
            {auditLog.map((a) => <div key={a.id} className="muted" style={{ fontSize: 12 }}>{new Date(a.created_at).toLocaleString()} — {a.message}</div>)}
          </div>
        </div>
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
    <div className="stack">
      <div className="card stack">
        <label className="stack" style={{ gap: 2 }}>
          <span className="muted" style={{ fontSize: 11 }}>Business name</span>
          <input
            className="input" style={{ fontSize: 18, fontWeight: 400, maxWidth: 360 }}
            value={businessName} onChange={(e) => setBusinessName(e.target.value)}
          />
        </label>

        <div className="wrap">
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>First name</span>
            <input className="input" style={{ width: 160 }} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Last name</span>
            <input className="input" style={{ width: 160 }} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Email address</span>
            <input className="input" style={{ width: 240 }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Website</span>
            <input className="input" style={{ width: 240 }} placeholder="https://yourbusiness.example" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 11 }}>Business address</span>
          <div className="wrap">
            <label className="stack" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>Address line 1</span>
              <input className="input" style={{ width: 220 }} value={line1} onChange={(e) => setLine1(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>Address line 2</span>
              <input className="input" style={{ width: 220 }} value={line2} onChange={(e) => setLine2(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>City</span>
              <input className="input" style={{ width: 160 }} value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 2 }}>
              <span className="muted" style={{ fontSize: 11 }}>Post / zip code</span>
              <input className="input" style={{ width: 120 }} value={postcode} onChange={(e) => setPostcode(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="row">
          <button className="btn" disabled={!dirty} onClick={save}>Save</button>
          {saved && <span className="muted" style={{ fontSize: 12 }}>Saved.</span>}
        </div>
      </div>

      <div className="card stack" style={{ background: "#FBEEDD" }}>
        <div style={{ fontSize: 13 }}>Staff Kiosk link: <code style={{ background: "#fff", padding: "2px 6px", borderRadius: 4 }}>{staffAppUrl}</code></div>
        <div className="muted" style={{ fontSize: 12 }}>
          Each location has its own sign-in code (open it in the Locations tab) — share that location's code with the staff working there.
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Customer link:</span>
          <code style={{ fontSize: 12, background: "#fff", padding: "2px 6px", borderRadius: 4 }}>{customerLink}</code>
          <button className="btn-outline" onClick={() => { navigator.clipboard?.writeText(customerLink); }}>Copy</button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>This is what a real customer link would open, once WhatsApp is wired up for real — useful for testing your setup now.</div>
      </div>

      <div className="card stack">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Licenses ({visibleLicenses.length})</div>
        {visibleLicenses.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No licenses yet.</div>}
        {visibleLicenses.map((lic, i) => {
          const meta = LICENSE_STATUS_META[lic.status] || { label: lic.status, color: "blue" };
          return (
            <div
              key={lic.id} className="row"
              style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, paddingTop: i === 0 ? 0 : 8, borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
            >
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                <strong style={{ fontSize: 13 }}>{lic.service_name}</strong>
                <span style={{ fontSize: 13 }}>{lic.plan_label}</span>
                {lic.start_date && <span className="muted" style={{ fontSize: 12 }}>{formatDateDisplay(lic.start_date)} to {formatDateDisplay(lic.end_date)}</span>}
                <span className="muted" style={{ fontSize: 12 }}>{Number(lic.price) > 0 ? `£${lic.price}` : "Free"}</span>
              </div>
              <div className="row">
                {(lic.status === "available" || lic.status === "scheduled") && <button className="btn-outline" onClick={() => refund(lic)}>Refund</button>}
                <button className="btn-outline" onClick={() => printLicenseReceipt(lic, lic.service_name, tenant.business_name, tenant.company_address)}>Print receipt</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card stack" style={{ borderColor: "var(--error, #B3261E)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--error, #B3261E)" }}>Delete account</div>
        <div className="muted" style={{ fontSize: 12 }}>
          This will permanently delete all of your data — every location, service, license and booking history. This can't be undone.
        </div>
        <div className="row">
          <button className="btn-outline" style={{ color: "var(--error, #B3261E)", borderColor: "var(--error, #B3261E)" }} onClick={deleteAccount}>Delete account</button>
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
    { name: "Admin System Set-up", price: "£125", desc: "Our team configures your services, hours, and staffing for you — done in one session.", action: { label: "Enquire", onClick: () => enquire("Admin system set-up enquiry") } },
  ];

  return (
    <div className="stack">
      <div className="muted" style={{ fontSize: 12 }}>
        A look at what's available — nothing here is purchased automatically yet, "Get a quote" opens an email to us directly.
      </div>

      <div style={{ fontSize: 13, fontWeight: 600 }}>Products</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {products.map((p) => (
          <div key={p.name} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong style={{ fontSize: 14 }}>{p.name}</strong>
              <span className={`badge ${p.price === "Free" ? "badge-green" : "badge-blue"}`}>{p.price}</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{p.desc}</div>
            <div><button className="btn-outline" onClick={p.action.onClick}>{p.action.label}</button></div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>Services</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {services.map((s) => (
          <div key={s.name} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong style={{ fontSize: 14 }}>{s.name}</strong>
              <span className="badge badge-blue">{s.price}</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{s.desc}</div>
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
    ["Price", lic.price != null ? `£${lic.price}` : "—"],
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

function ServiceEditor({ service, allServices, onChange, setError, tenant }) {
  const [expanded, setExpanded] = useState(false);
  const [buyTrigger, setBuyTrigger] = useState(0);
  const [licenses, setLicenses] = useState([]);
  const [calendarRefresh, setCalendarRefresh] = useState(0);

  async function loadLicenses() {
    try { const r = await api.getServiceLicenses(service.id); setLicenses(r.licenses); } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadLicenses(); }, [service.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = licenseSummary(licenses);
  const hasActiveLicense = licenses.some((l) => l.status === "active");

  // Fake for now — there's no real WhatsApp Business number wired up yet, so the QR just
  // points at the same stand-in customer link the Setup tab shows, with the service tagged
  // on so the real version can route straight to it once WhatsApp is actually connected.
  function printServiceQR() {
    const CUSTOMER_APP_URL = import.meta.env.VITE_CUSTOMER_APP_URL || "http://localhost:5177";
    const link = `${CUSTOMER_APP_URL}/?t=${tenant.id}&s=${service.id}`;
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
    <div className="card stack" style={{ gap: 8, ...(service.archived ? { opacity: 0.6 } : null) }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <strong>{service.name}</strong>
          <span className="badge badge-blue" style={{ textTransform: "capitalize" }}>{service.mode}</span>
          {service.mode !== "queue" && <span className="muted" style={{ fontSize: 12 }}>{service.slot_minutes} min slots</span>}
          {service.archived && <span className="badge badge-amber">Archived</span>}
          <span className={`badge badge-${summary.color}`}>{summary.text}</span>
        </div>
        <div className="row">
          <select
            className="btn-outline"
            defaultValue=""
            onChange={async (e) => {
              const action = e.target.value;
              e.target.value = "";
              if (action === "buy") { setExpanded(true); setBuyTrigger((t) => t + 1); }
              else if (action === "qr") printServiceQR();
              else if (action === "archive" && confirm(`Archive "${service.name}"? It'll move to the Audit tab, and you can unarchive it from there any time. Its license history is kept.`)) {
                await api.updateService(service.id, { archived: true });
                onChange();
              }
            }}
          >
            <option value="" disabled>⋯</option>
            <option value="buy">Buy a license</option>
            <option value="qr">Print QR customer display</option>
            <option value="archive">Archive</option>
          </select>
          <button className="btn-outline" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {service.mode === "queue" && hasActiveLicense && (
        <div className="row">
          <button className="btn-outline" onClick={async () => { await api.updateService(service.id, { queuePaused: !service.queue_paused }); onChange(); }}>
            {service.queue_paused ? "Resume" : "Pause (busy)"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>A live override on top of the scheduled hours below — pause anytime without touching your calendar.</span>
        </div>
      )}
      {expanded && (
        <div className="stack" style={{ gap: 10, paddingTop: 2, borderTop: "1px solid var(--line)" }}>
          <ServiceLicensesPanel
            service={service} allServices={allServices || []} setError={setError}
            onChanged={() => { loadLicenses(); onChange(); setCalendarRefresh((t) => t + 1); }}
            tenant={tenant} buyTrigger={buyTrigger} showBuyButton={false}
          />
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
function ServiceLicensesPanel({ service, allServices, setError, onChanged, tenant, buyTrigger, showBuyButton = true, hideHeader = false, onBought }) {
  const [licenses, setLicenses] = useState([]);
  const [pricing, setPricing] = useState(null);
  const [buying, setBuying] = useState(false);
  // Buying is two steps, same shape as the signup wizard: pick the license type first,
  // then (only when it isn't free) confirm how it's paid for, before it's actually bought.
  const [buyStep, setBuyStep] = useState("plan");
  const [planId, setPlanId] = useState("week");
  const [customDays, setCustomDays] = useState(7);
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
      const r = await api.buyServiceLicense(service.id, { planId, customDays: planId === "custom" ? customDays : undefined });
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

  return (
    <div className="stack" style={{ gap: 8 }}>
      {!hideHeader && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: 13 }}>Licenses</strong>
          {showBuyButton && !buying && <button className="btn-outline" onClick={() => { setBuying(true); setBuyStep("plan"); }}>Buy a license</button>}
        </div>
      )}

      {buying && pricing && buyStep === "plan" && (
        <div className="card stack" style={{ background: "#FBEEDD" }}>
          <div className="stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: 13 }}>Select license type</strong>
          </div>
          <div className="plan-grid">
            {["day", "week", "month", "year", "custom"].map((id) => {
              const onSale = id !== "custom" && pricing.sale?.active && pricing.sale[id] != null;
              const price = id === "custom" ? null : (onSale ? pricing.sale[id] : pricing[id]);
              return (
                <div key={id} className={`plan-option${planId === id ? " active" : ""}`} onClick={() => setPlanId(id)}>
                  <span className="plan-option-label">{id === "custom" ? "Custom" : id.charAt(0).toUpperCase() + id.slice(1)}</span>
                  <span className="plan-option-price">{id === "custom" ? `from £${pricing.customDailyRate}/day` : `£${price}`}</span>
                </div>
              );
            })}
          </div>
          {planId === "custom" && (
            <div className="row">
              <span className="muted">Days:</span>
              <input className="input" type="number" min={1} style={{ width: 70 }} value={customDays} onChange={(e) => setCustomDays(Math.max(1, Number(e.target.value) || 1))} />
            </div>
          )}
          <div className="row">
            <button className="btn" onClick={() => (selectedPrice() > 0 ? setBuyStep("payment") : buy())}>
              {selectedPrice() > 0 ? "Continue" : "Buy — free"}
            </button>
            <button className="btn-outline" onClick={() => setBuying(false)}>Cancel</button>
          </div>
        </div>
      )}

      {buying && pricing && buyStep === "payment" && (
        <div className="card stack" style={{ background: "#FBEEDD" }}>
          <div className="stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: 13 }}>How this is paid</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {(planId === "custom" ? "Custom" : planId.charAt(0).toUpperCase() + planId.slice(1))} license — £{selectedPrice()}
            </span>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <div className={`payment-option${tenant?.payment_method !== "invoice" ? " active" : ""}`}>
              <span className="payment-option-title">Card</span>
              <span className="payment-option-desc">Charged to the card on file — access is immediate.</span>
            </div>
            <div className={`payment-option${tenant?.payment_method === "invoice" ? " active" : ""}`}>
              <span className="payment-option-title">Invoice</span>
              <span className="payment-option-desc">
                {tenant?.status === "pending"
                  ? "Added to your account's invoice — your initial invoice payment hasn't been confirmed yet, so this license will be held, same as the rest of your account, until it clears."
                  : "Added to your next invoice — access is immediate, billed per your invoice terms."}
              </span>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>This follows your account's payment method on file — contact us to change it.</div>
          <div className="row">
            <button className="btn" onClick={buy}>Confirm &amp; buy</button>
            <button className="btn-outline" onClick={() => setBuyStep("plan")}>Back</button>
            <button className="btn-outline" onClick={() => setBuying(false)}>Cancel</button>
          </div>
        </div>
      )}

      {visible.length === 0 && !buying && <div className="muted" style={{ fontSize: 13 }}>No licenses yet — buy one to make this service bookable.</div>}

      {visible.map((lic, i) => {
        const meta = LICENSE_STATUS_META[lic.status];
        return (
          <div key={lic.id} className="stack" style={{ gap: 6, paddingTop: i === 0 ? 0 : 8, borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                <strong style={{ fontSize: 13 }}>{lic.plan_label}</strong>
                {lic.start_date && <span className="muted" style={{ fontSize: 12 }}>{formatDateDisplay(lic.start_date)} to {formatDateDisplay(lic.end_date)}</span>}
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {lic.status === "available" && schedulingId !== lic.id && (
                  <button className="btn-outline" onClick={() => { setSchedulingId(lic.id); setStartDate(lic.start_date || todayIso()); }}>
                    Assign dates
                  </button>
                )}
                {movingId === lic.id ? (
                  <select defaultValue="" onChange={(e) => { if (e.target.value) move(lic, e.target.value); }}>
                    <option value="" disabled>Move to…</option>
                    {otherServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : (
                  <select
                    className="btn-outline"
                    defaultValue=""
                    onChange={(e) => {
                      const action = e.target.value;
                      e.target.value = "";
                      if (action === "move") setMovingId(lic.id);
                      else if (action === "changeDates") { setSchedulingId(lic.id); setStartDate(lic.start_date || todayIso()); }
                      else if (action === "unschedule") unschedule(lic);
                    }}
                  >
                    <option value="" disabled>Actions</option>
                    {lic.status === "scheduled" && <option value="changeDates">Change dates</option>}
                    {lic.status === "scheduled" && <option value="unschedule">Unschedule</option>}
                    {lic.status === "available" && otherServices.length > 0 && <option value="move">Move License</option>}
                  </select>
                )}
              </div>
            </div>
            {schedulingId === lic.id && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="muted" style={{ fontSize: 12 }}>Start date:</span>
                <input className="input" type="date" style={{ maxWidth: 160 }} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <span className="muted" style={{ fontSize: 12 }}>→ ends {formatDateDisplay(addDaysIso(startDate, lic.plan_days - 1))}</span>
                <button className="btn" onClick={() => schedule(lic)}>Confirm</button>
                <button className="btn-outline" onClick={() => setSchedulingId(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
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

  const selectedIsPast = !!selectedDate && isDatePastClient(selectedDate);
  const selectedIsToday = !!selectedDate && selectedDate === todayIso();
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
        await api.putDailyConfig(service.id, { date: dateToSave, hours: hoursToSave, staffCount: staffCountRef.current, bookingStaffCount: bookingRef.current, walkInStaffCount: walkInRef.current });
        setMonthConfigs((prev) => ({ ...prev, [dateToSave]: { date: dateToSave, hours: hoursToSave, staff_count: staffCountRef.current, booking_staff_count: bookingRef.current, walkin_staff_count: walkInRef.current } }));
        setSaveStatus("saved");
        savedIndicatorRef.current = setTimeout(() => setSaveStatus(""), 1500);
      } catch (err) {
        setError(err.message);
        setSaveStatus("error");
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
    try {
      await api.putDailyConfig(service.id, { date: selectedDate, hours, staffCount: nextStaff, bookingStaffCount: nextBooking, walkInStaffCount: nextWalkIn });
      setMonthConfigs((prev) => ({ ...prev, [selectedDate]: { date: selectedDate, hours, staff_count: nextStaff, booking_staff_count: nextBooking, walkin_staff_count: nextWalkIn } }));
      setSaveStatus("saved");
      if (savedIndicatorRef.current) clearTimeout(savedIndicatorRef.current);
      savedIndicatorRef.current = setTimeout(() => setSaveStatus(""), 1500);
    } catch (err) {
      setError(err.message);
      setSaveStatus("error");
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
    const targets = Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i)).filter((d) => d !== selectedDate);
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }
  async function copyToMonth() {
    const fm = firstOfMonth(selectedDate);
    const n = daysInMonthOf(fm);
    const targets = Array.from({ length: n }, (_, i) => addDaysIso(fm, i)).filter((d) => d !== selectedDate);
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }
  async function copyToWholePeriod() {
    if (!windows.length) return;
    const targets = [];
    for (const w of windows) {
      let d = w.start;
      let guard = 0;
      while (d <= w.end && guard < 400) { if (d !== selectedDate) targets.push(d); d = addDaysIso(d, 1); guard++; }
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
      <div className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div className="card" style={{ minWidth: 220 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <button className="btn-outline" disabled={overallStart && calendarMonth <= firstOfMonth(overallStart)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, -1))}>‹</button>
            <strong style={{ fontSize: 13 }}>{monthLabel(calendarMonth)}</strong>
            <button className="btn-outline" disabled={overallEnd && calendarMonth >= firstOfMonth(overallEnd)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, 1))}>›</button>
          </div>
          <table>
            <thead><tr>{DAY_LETTERS.map((d, i) => <th key={i} style={{ padding: 2, fontSize: 10 }}>{d}</th>)}</tr></thead>
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
                      <td key={di} style={{ padding: 2 }}>
                        <button
                          onClick={() => inWindow && setSelectedDate(d)}
                          disabled={!inWindow}
                          title={!inWindow ? "Not covered by a license for this service" : past ? "In the past — view only" : isToday ? "Today — you can still set hours for the rest of the day" : `${count} half-hour block(s) open`}
                          style={{
                            width: 26, height: 24, fontSize: 11, borderRadius: 4, border: isToday ? "1.5px solid #1B1D1F" : "1px solid #DEDDD6",
                            background: isSelected ? "#1D5C8A" : count > 0 ? "#E6EEF3" : "#fff",
                            color: isSelected ? "#fff" : !inWindow ? "#DEDDD6" : "#1B1D1F",
                            opacity: inWindow ? 1 : 0.4,
                          }}
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

        <div className="stack" style={{ flex: 1, minWidth: 260 }}>
          {selectedDate && (
            <>
              {(saveStatus === "saving" || saveStatus === "saved" || saveStatus === "error") && (
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  {saveStatus === "saving" && <span className="muted" style={{ fontSize: 12 }}>Saving…</span>}
                  {saveStatus === "saved" && <span style={{ fontSize: 12, color: "#2F6F4E" }}>✓ Saved</span>}
                  {saveStatus === "error" && <span style={{ fontSize: 12, color: "#B3261E" }}>Save failed</span>}
                </div>
              )}
              <div className="wrap" style={{ userSelect: "none" }}>
                {GRID_HOURS.map((h) => {
                  const open = draftHours.includes(h);
                  const editable = isBlockEditable(h);
                  return (
                    <span
                      key={h}
                      onMouseDown={() => beginPaint(h)}
                      onMouseEnter={() => continuePaint(h)}
                      className="badge"
                      title={!editable && selectedIsToday ? "Already passed" : undefined}
                      style={{ cursor: editable ? "pointer" : "default", background: open ? "#1D5C8A" : "#F7F7F4", color: open ? "#fff" : "#1B1D1F", opacity: editable ? 1 : 0.5 }}
                    >
                      {formatTime(h)}
                    </span>
                  );
                })}
              </div>

              {!selectedIsPast && (
                <div className="row" style={{ gap: 6 }}>
                  <span className="muted" style={{ fontSize: 12, minWidth: 68 }}>This day:</span>
                  <button className="btn-outline" style={{ fontWeight: 400 }} onClick={fillNineToFive}>Set 9–5</button>
                  <button className="btn-outline" style={{ fontWeight: 400 }} onClick={clearDay}>Clear day</button>
                </div>
              )}

              <div className="row" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 12, minWidth: 68 }}>Staff:</span>
                <input
                  className="input"
                  style={{ width: 60 }}
                  type="number"
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
                    <span className="muted" style={{ fontSize: 12 }}>On bookings:</span>
                    <input
                      className="input"
                      style={{ width: 60 }}
                      type="number"
                      min={0}
                      disabled={selectedIsPast}
                      value={bookingStaffCount}
                      onChange={(e) => {
                        const nextBooking = Math.max(0, Math.min(Number(e.target.value) || 0, staffCount));
                        const nextWalkIn = Math.min(walkInStaffCount, staffCount - nextBooking);
                        saveNow({ bookingStaffCount: nextBooking, walkInStaffCount: nextWalkIn });
                      }}
                    />
                    <span className="muted" style={{ fontSize: 12 }}>On walk-ins:</span>
                    <input
                      className="input"
                      style={{ width: 60 }}
                      type="number"
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

              {!selectedIsPast && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="muted" style={{ fontSize: 12, minWidth: 68 }}>Copy to:</span>
                  <button className="btn-outline" style={{ fontWeight: 400 }} onClick={copyToWeek}>Rest of week</button>
                  <button className="btn-outline" style={{ fontWeight: 400 }} onClick={copyToMonth}>Rest of month</button>
                  <button className="btn-outline" style={{ fontWeight: 400 }} onClick={copyToWholePeriod}>All licensed dates</button>
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

function ServiceWizard({ locationId, allServices, onDone, onAdded, onCancel, setError, tenant }) {
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
      <div className="card stack" style={{ background: "#FBEEDD", border: "1px solid #1B1D1F" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>New service — step 1 of 3</div>
        <input className="input" autoFocus placeholder="Service name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="stack">
          {SERVICE_MODE_INFO.map((m) => (
            <label key={m.id} className="card row" style={{ cursor: "pointer", alignItems: "flex-start", background: mode === m.id ? "#fff" : "transparent", borderColor: mode === m.id ? "#1B1D1F" : undefined }}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} style={{ marginTop: 3 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{m.label}</div>
                <div className="muted" style={{ fontSize: 12 }}>{m.text}</div>
              </div>
            </label>
          ))}
        </div>
        {needsSlotLength && (
          <div className="row">
            <span className="muted">Slot length:</span>
            <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
              {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
        )}
        <div className="muted" style={{ fontSize: 11 }}>The name, type, slot length, and location can't be changed after this step — delete and recreate the service if you need to change them later.</div>
        <div className="row">
          <button className="btn" disabled={!name.trim() || creating} onClick={next}>{creating ? "Creating…" : "Next: buy a license →"}</button>
          <button className="btn-outline" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="card stack" style={{ background: "#FBEEDD", border: "1px solid #1B1D1F" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>New service — step 2 of 2: buy a license for "{createdService.name}"</div>
        <div className="muted" style={{ fontSize: 12 }}>This license is bound to this service. Assign it to calendar dates any time from the service's own panel.</div>
        <ServiceLicensesPanel
          service={createdService} allServices={allServices || []} setError={setError}
          onChanged={() => {}} tenant={tenant} buyTrigger={1} hideHeader
          onBought={() => setStep(3)}
        />
      </div>
    );
  }

  return (
    <div className="card stack" style={{ background: "#FBEEDD", border: "1px solid #1B1D1F" }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>"{createdService.name}" is ready</div>
      <div className="muted" style={{ fontSize: 12 }}>License bought — assign it to calendar dates any time from the service's own panel.</div>
      <div className="row">
        <button className="btn-outline" onClick={addAnother}>+ Add another service</button>
        <button className="btn" onClick={() => onDone(createdService)}>Done</button>
      </div>
    </div>
  );
}
