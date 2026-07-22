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

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <strong>{tenant ? tenant.business_name : "QBooker Admin"}</strong>
        <div className="row">
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
          {tenant && <span style={{ fontSize: 12, opacity: 0.85 }}>{tenant.status === "pending" ? "Payment pending" : "Active"}</span>}
          <a href={import.meta.env.VITE_MARKETING_URL || "http://localhost:5175"} style={{ color: "#fff", fontSize: 13 }}>New here? Sign up →</a>
        </div>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#C22A1E", color: "#C22A1E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "admin-login" && <AdminLogin onSignedIn={(t) => { setTenant(t); setScreen("admin"); }} setError={setError} />}
      {screen === "admin" && tenant && <AdminDashboard tenant={tenant} setError={setError} onSignOut={() => { setToken("tenant_admin", null); setTenant(null); setScreen("admin-login"); }} />}
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
    <div className="card" style={{ background: "#FBE9E7", borderColor: "#C22A1E", color: "#C22A1E", fontSize: 13, fontWeight: 500 }}>
      Payment pending — your account can be configured now, but staff kiosk and customer WhatsApp won't work until payment is received.
    </div>
  );
}

function LocationWebsiteField({ loc, setError, onChanged }) {
  const [url, setUrl] = useState(loc.website_url || "");
  const [saved, setSaved] = useState(false);

  async function save() {
    try {
      await api.updateLocation(loc.id, { websiteUrl: url.trim() || null });
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 1500);
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className="muted" style={{ fontSize: 12 }}>Website (opening hours):</span>
      <input className="input" style={{ maxWidth: 260 }} placeholder="https://yourbusiness.example" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn-outline" onClick={save}>Save</button>
      {saved && <span style={{ fontSize: 12, color: "#14803C" }}>✓ Saved</span>}
    </div>
  );
}

function AdminDashboard({ tenant, setError, onSignOut }) {
  const [tab, setTab] = useState("locations");
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [expandedLocations, setExpandedLocations] = useState({});
  const [addingServiceFor, setAddingServiceFor] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const date = todayIso();
  const STAFF_APP_URL = import.meta.env.VITE_STAFF_APP_URL || "http://localhost:5176";
  const CUSTOMER_APP_URL = import.meta.env.VITE_CUSTOMER_APP_URL || "http://localhost:5177";
  const customerLink = `${CUSTOMER_APP_URL}/?t=${tenant.id}`;

  async function refreshCore() {
    try {
      const [locRes, svcRes] = await Promise.all([api.getLocations(), api.getServices()]);
      setLocations(locRes.locations); setServices(svcRes.services);
    } catch (err) { setError(err.message); }
  }
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
  useEffect(() => { refreshCore(); refreshQueue(); refreshAudit(); }, []);

  // Light polling for near-real-time (not a WebSocket/Supabase-realtime subscription — just periodic refetch).
  useEffect(() => {
    const id = setInterval(() => { refreshQueue(); }, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
      <div className="wrap">
        {["locations", "billing", "shop", "dashboard", "audit"].map((t) => (
          <button key={t} className={tab === t ? "btn" : "btn-outline"} onClick={() => { setTab(t); if (t === "dashboard") refreshQueue(); if (t === "audit") refreshAudit(); }}>{t}</button>
        ))}
      </div>

      {tab === "locations" && (
        <div className="stack">
          <PendingPaymentBanner tenant={tenant} />
          <div className="card stack" style={{ background: "#E4F0FB" }}>
            <div style={{ fontSize: 13 }}>Staff Kiosk link: <code style={{ background: "#fff", padding: "2px 6px", borderRadius: 4 }}>{STAFF_APP_URL}</code></div>
            <div className="muted" style={{ fontSize: 12 }}>
              Each location below has its own sign-in code — share that location's code with the staff working there.
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>Customer link:</span>
              <code style={{ fontSize: 12, background: "#fff", padding: "2px 6px", borderRadius: 4 }}>{customerLink}</code>
              <button className="btn-outline" onClick={() => { navigator.clipboard?.writeText(customerLink); }}>Copy</button>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>This is what a real customer link would open, once WhatsApp is wired up for real — useful for testing your setup now.</div>
          </div>
          {locations.map((loc) => {
            const locServices = services.filter((s) => s.location_id === loc.id);
            const isOpen = !!expandedLocations[loc.id];
            const addingHere = addingServiceFor === loc.id;
            return (
              <div key={loc.id} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <button className="btn-outline" onClick={() => setExpandedLocations((prev) => ({ ...prev, [loc.id]: !prev[loc.id] }))}>
                      {isOpen ? "▾" : "▸"}
                    </button>
                    <input
                      className="input" style={{ maxWidth: 180, fontWeight: 600 }} defaultValue={loc.name}
                      onBlur={async (e) => { const v = e.target.value.trim(); if (v && v !== loc.name) { await api.updateLocation(loc.id, { name: v }); refreshCore(); } else { e.target.value = loc.name; } }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                    />
                    <span className="muted" style={{ fontSize: 12 }}>{locServices.length} service{locServices.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="row">
                    <button className="btn" onClick={() => { setAddingServiceFor(loc.id); setExpandedLocations((prev) => ({ ...prev, [loc.id]: true })); }}>Add service</button>
                    <button
                      className="btn-outline"
                      onClick={async () => {
                        if (confirm(`Remove "${loc.name}"? This also removes its services and can't be undone.`)) {
                          await api.deleteLocation(loc.id);
                          refreshCore();
                        }
                      }}
                    >
                      Remove location
                    </button>
                  </div>
                </div>

                <div className="row">
                  <span className="muted" style={{ fontSize: 12 }}>Staff sign-in code:</span>
                  <code style={{ fontSize: 13, letterSpacing: 1, background: "#F2F6F9", padding: "2px 8px", borderRadius: 4 }}>{loc.staff_access_code || "—"}</code>
                </div>
                <LocationWebsiteField loc={loc} setError={setError} onChanged={refreshCore} />

                {addingHere && (
                  <ServiceWizard
                    locationId={loc.id}
                    setError={setError}
                    onCancel={() => setAddingServiceFor(null)}
                    onDone={() => { setAddingServiceFor(null); refreshCore(); }}
                  />
                )}

                {isOpen && (
                  <div className="stack" style={{ paddingLeft: 20, borderLeft: "2px solid #DCE4EA" }}>
                    {locServices.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No services here yet — click "Add service" above.</div>}
                    {locServices.map((s) => <ServiceEditor key={s.id} service={s} onChange={refreshCore} setError={setError} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "billing" && (
        <BillingTab tenant={tenant} locations={locations} setError={setError} onLocationsChanged={refreshCore} />
      )}

      {tab === "shop" && <ShopTab tenant={tenant} locations={locations} />}

      {tab === "dashboard" && (
        <div className="stack">
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn-outline" onClick={refreshQueue}>Refresh</button></div>
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
        <div className="card stack">
          {auditLog.length === 0 && <div className="muted">No activity yet.</div>}
          {auditLog.map((a) => <div key={a.id} className="muted" style={{ fontSize: 12 }}>{new Date(a.created_at).toLocaleString()} — {a.message}</div>)}
        </div>
      )}
    </div>
  );
}

function locationWindow(loc) {
  return loc.start_date && loc.end_date ? { start: loc.start_date, end: loc.end_date } : null;
}
function locationStatus(loc) {
  if (!loc.plan_id) return "none";
  if (!loc.start_date) return "purchased"; // bought, dormant — hasn't started yet
  const today = todayIso();
  return today > loc.end_date ? "expired" : "live";
}

function BillingTab({ tenant, locations, setError, onLocationsChanged }) {
  const [buyingLocation, setBuyingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [pricing, setPricing] = useState(null);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  return (
    <div className="stack">
      <PendingPaymentBanner tenant={tenant} />

      <div className="card stack">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Buy another location</div>
        {!buyingLocation && <div><button className="btn" onClick={() => setBuyingLocation(true)}>Buy another location</button></div>}
        {buyingLocation && (
          <div className="stack" style={{ background: "#E4F0FB", borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 13 }}>
              Adding a location costs <strong>£{tenant.price_per_location}</strong> for your current plan
              {tenant.payment_method === "invoice" ? " — added to your next invoice." : " — charged to your card on file."}
              {" "}It gets its own {tenant.plan_label?.toLowerCase()} license, which starts the moment you set opening hours for a service there — independent of your other locations.
            </div>
            <div className="row">
              <input className="input" placeholder="New location name" value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
              <button className="btn" disabled={!newLocationName.trim()} onClick={async () => { try { await api.addLocation(newLocationName); setNewLocationName(""); setBuyingLocation(false); onLocationsChanged(); } catch (err) { setError(err.message); } }}>Buy &amp; add</button>
              <button className="btn-outline" onClick={() => { setBuyingLocation(false); setNewLocationName(""); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="stack">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Locations &amp; licenses</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Each location's license runs independently — extend one without affecting the others. Expand a location to see
          everything bought for it and download a receipt.
        </div>
        {locations.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No locations yet.</div>}
        {locations.map((loc) => (
          <LocationLicenseRow key={loc.id} loc={loc} tenant={tenant} pricing={pricing} setError={setError} onChanged={onLocationsChanged} />
        ))}
      </div>
    </div>
  );
}

function LocationLicenseRow({ loc, tenant, pricing, setError, onChanged }) {
  const [choosing, setChoosing] = useState(false);
  const [chosenPlan, setChosenPlan] = useState(null);
  const [extending, setExtending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState(null);

  const licenseWindow = locationWindow(loc);
  const status = locationStatus(loc);
  const statusMeta = {
    live: { label: "Live", color: "green" },
    expired: { label: "License expired", color: "red" },
    purchased: { label: "Purchased — not started", color: "amber" },
    none: { label: "No license assigned", color: "amber" },
  }[status];

  const windowText = !loc.plan_label
    ? "No license assigned yet"
    : !licenseWindow
      ? `${loc.plan_label} — starts the moment you set opening hours for a service here`
      : loc.plan_days === 1
        ? `${loc.plan_label} — ${licenseWindow.start}, until midnight`
        : `${loc.plan_label} — ${licenseWindow.start} to ${licenseWindow.end}`;

  const sale = pricing?.sale?.active ? pricing.sale : null;
  function planPrice(p) {
    if (sale && sale[p] != null) return sale[p];
    return pricing?.[p];
  }

  async function loadHistory() {
    try {
      const r = await api.getLicenseHistory(loc.id);
      setHistory(r.purchases);
    } catch (err) { setError(err.message); }
  }
  function toggleExpand() {
    setExpanded((v) => {
      if (!v && !history) loadHistory();
      return !v;
    });
  }

  function downloadReceipt(purchase) {
    const lines = [
      "QBOOKER — RECEIPT",
      "==================",
      "",
      `Business: ${tenant.business_name}`,
      `Location: ${loc.name}`,
      "",
      `Plan: ${purchase.plan_label}`,
      `Price: £${purchase.price}`,
      purchase.start_date ? `Covers: ${purchase.start_date}${purchase.end_date && purchase.end_date !== purchase.start_date ? ` to ${purchase.end_date}` : ""}` : null,
      `Date bought: ${new Date(purchase.purchased_at).toLocaleDateString()}`,
      "",
      `Payment method: ${tenant.payment_method === "invoice" ? "Invoice" : "Card"}`,
      tenant.invoice_po ? `PO / reference number: ${tenant.invoice_po}` : null,
      `Account status: ${tenant.status === "active" ? "Active" : "Payment pending"}`,
      "",
      `Issued: ${new Date().toLocaleDateString()}`,
    ].filter(Boolean);
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qbooker-receipt-${loc.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date(purchase.purchased_at).toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function confirmExtend() {
    setExtending(true);
    try {
      await api.extendLocationLicense(loc.id, { planId: chosenPlan });
      setChoosing(false);
      setChosenPlan(null);
      setHistory(null);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setExtending(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row">
          <button className="btn-outline" onClick={toggleExpand} title={expanded ? "Collapse" : "Expand"}>{expanded ? "▾" : "▸"}</button>
          <strong>{loc.name}</strong>
          <span className={`badge badge-${statusMeta.color}`}>{statusMeta.label}</span>
        </div>
        {!choosing && <button className="btn-outline" onClick={() => setChoosing(true)}>Extend license</button>}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{windowText}</div>

      {choosing && !chosenPlan && (
        <div className="wrap">
          {["day", "week", "month", "year"].map((p) => (
            <button key={p} className="btn-outline" onClick={() => setChosenPlan(p)}>
              {p[0].toUpperCase() + p.slice(1)} — {sale && sale[p] != null && (
                <span className="muted" style={{ textDecoration: "line-through" }}>£{pricing?.[p]}</span>
              )} £{planPrice(p) ?? "…"}
            </button>
          ))}
          <button className="btn-outline" onClick={() => setChoosing(false)}>Cancel</button>
        </div>
      )}

      {chosenPlan && (
        <div className="stack" style={{ background: "#E4F0FB", borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 13 }}>
            Extend "{loc.name}" with a {chosenPlan} pass — <strong>£{planPrice(chosenPlan)}</strong>.
            {status === "live"
              ? ` It'll pick up automatically the day your current license ends (${licenseWindow.end}) and hours are set for it — never before.`
              : " It'll start the moment you set opening hours for a service here."}
          </div>
          <div className="row">
            <button className="btn" disabled={extending} onClick={confirmExtend}>{extending ? "Extending…" : "Confirm & extend"}</button>
            <button className="btn-outline" onClick={() => setChosenPlan(null)}>Back</button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="stack" style={{ borderTop: "1px solid #DCE4EA", paddingTop: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>Licenses bought for this location</span>
          {!history && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
          {history && history.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Nothing recorded yet.</div>}
          {history && history.length > 0 && (
            <table>
              <thead><tr><th>Date bought</th><th>Plan</th><th>Covers</th><th>Price</th><th></th></tr></thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id}>
                    <td>{new Date(p.purchased_at).toLocaleDateString()}</td>
                    <td>{p.plan_label}</td>
                    <td>{p.start_date ? (p.end_date && p.end_date !== p.start_date ? `${p.start_date} – ${p.end_date}` : p.start_date) : "—"}</td>
                    <td>£{p.price}</td>
                    <td><button className="btn-outline" onClick={() => downloadReceipt(p)}>Receipt</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
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
      <div style="border:2px solid #0F5FBF;border-radius:14px;padding:32px;margin-bottom:28px;text-align:center;page-break-inside:avoid;">
        <div style="font-size:22px;font-weight:700;margin-bottom:4px;">${tenant.business_name}</div>
        <div style="font-size:14px;color:#5B6B79;margin-bottom:20px;">${l.name}</div>
        <div style="font-size:17px;font-weight:600;margin-bottom:10px;">📱 Message us on WhatsApp to get started</div>
        <div style="font-size:15px;color:#1B2733;margin-bottom:6px;">Send this code:</div>
        <div style="font-size:28px;font-weight:700;letter-spacing:2px;background:#F2F6F9;border-radius:8px;padding:10px 0;">${l.code}</div>
        <div style="font-size:12px;color:#5B6B79;margin-top:18px;">Join the queue or book a slot instantly — no app to download.</div>
      </div>
    `).join("");
    const html = `<!doctype html><html><head><title>QBooker brochure — ${tenant.business_name}</title>
      <meta charset="utf-8" />
      <style>body{font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:40px auto;color:#1B2733;}</style>
      </head><body>${cards}<p style="text-align:center;color:#5B6B79;font-size:11px;">Print this page and display it in your waiting area.</p></body></html>`;
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

function ServiceEditor({ service, onChange, setError }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <strong>{service.name}</strong>
          <span className="badge badge-blue" style={{ textTransform: "capitalize" }}>{service.mode}</span>
          {service.mode !== "queue" && <span className="muted" style={{ fontSize: 12 }}>{service.slot_minutes} min slots</span>}
        </div>
        <div className="row">
          <button className="btn-outline" onClick={async () => { if (confirm(`Delete "${service.name}"? This can't be undone.`)) { await api.deleteService(service.id); onChange(); } }}>Delete</button>
          <button className="btn-outline" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {service.mode === "queue" && (
        <div className="row">
          <button className="btn-outline" onClick={async () => { await api.updateService(service.id, { queuePaused: !service.queue_paused }); onChange(); }}>
            {service.queue_paused ? "Resume" : "Pause (busy)"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>A live override on top of the scheduled hours below — pause anytime without touching your calendar.</span>
        </div>
      )}

      {expanded && <ServiceCalendar service={service} setError={setError} />}
    </div>
  );
}

// Shared by ServiceEditor (post-setup editing) and ServiceWizard (step 2, right after creation).
function ServiceCalendar({ service, setError }) {
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [calendarMonth, setCalendarMonth] = useState(firstOfMonth(todayIso()));
  const [monthConfigs, setMonthConfigs] = useState({});
  const [planWindow, setPlanWindow] = useState(null);
  const [draftHours, setDraftHours] = useState([]);
  const [staffCount, setStaffCount] = useState(2);
  const [bookingStaffCount, setBookingStaffCount] = useState(1);
  const [saveStatus, setSaveStatus] = useState(""); // "", "saving", "saved", "error"

  const paintingRef = useRef(false);
  const paintModeRef = useRef(true);
  const staffCountRef = useRef(2);
  const bookingRef = useRef(1);
  const saveTimeoutRef = useRef(null);
  const savedIndicatorRef = useRef(null);

  useEffect(() => { staffCountRef.current = staffCount; }, [staffCount]);
  useEffect(() => { bookingRef.current = bookingStaffCount; }, [bookingStaffCount]);

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
      setPlanWindow(r.window);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadMonth(calendarMonth); }, [calendarMonth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const entry = monthConfigs[selectedDate];
    setDraftHours(entry?.hours || []);
    setStaffCount(entry?.staff_count ?? 2);
    setBookingStaffCount(entry?.booking_staff_count ?? 1);
  }, [selectedDate, monthConfigs]);

  const selectedIsPast = isDatePastClient(selectedDate);
  const selectedIsToday = selectedDate === todayIso();
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
        await api.putDailyConfig(service.id, { date: dateToSave, hours: hoursToSave, staffCount: staffCountRef.current, bookingStaffCount: bookingRef.current });
        setMonthConfigs((prev) => ({ ...prev, [dateToSave]: { date: dateToSave, hours: hoursToSave, staff_count: staffCountRef.current, booking_staff_count: bookingRef.current } }));
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
    if (patch.hours) setDraftHours(patch.hours);
    if (patch.staffCount !== undefined) setStaffCount(patch.staffCount);
    if (patch.bookingStaffCount !== undefined) setBookingStaffCount(patch.bookingStaffCount);
    setSaveStatus("saving");
    try {
      await api.putDailyConfig(service.id, { date: selectedDate, hours, staffCount: nextStaff, bookingStaffCount: nextBooking });
      setMonthConfigs((prev) => ({ ...prev, [selectedDate]: { date: selectedDate, hours, staff_count: nextStaff, booking_staff_count: nextBooking } }));
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

  async function clearAllDays() {
    if (!planWindow) return;
    if (!confirm("Clear hours for every day in your paid period? Already-passed hours today are kept — everything else is wiped. This can't be undone.")) return;
    try {
      let todayHours = monthConfigs[todayIso()]?.hours;
      if (todayHours === undefined) {
        const r = await api.getDailyConfig(service.id, todayIso(), todayIso());
        todayHours = r.dailyConfig[0]?.hours || [];
      }
      const keep = todayHours.filter((h) => h < currentMinutes);
      await api.clearAllDailyConfig(service.id, { keepHoursForToday: keep });
      await loadMonth(calendarMonth);
    } catch (err) { setError(err.message); }
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
    if (!planWindow) return;
    const targets = [];
    let d = planWindow.start;
    let guard = 0;
    while (d <= planWindow.end && guard < 400) { if (d !== selectedDate) targets.push(d); d = addDaysIso(d, 1); guard++; }
    try { await api.copyDailyConfig(service.id, { fromDate: selectedDate, toDates: targets }); loadMonth(calendarMonth); } catch (err) { setError(err.message); }
  }

  const calendarWeeks = buildCalendarWeeks(calendarMonth);

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div className="card" style={{ minWidth: 220 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <button className="btn-outline" disabled={planWindow && calendarMonth <= firstOfMonth(planWindow.start)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, -1))}>‹</button>
            <strong style={{ fontSize: 13 }}>{monthLabel(calendarMonth)}</strong>
            <button className="btn-outline" disabled={planWindow && calendarMonth >= firstOfMonth(planWindow.end)} onClick={() => setCalendarMonth(addMonthsIso(calendarMonth, 1))}>›</button>
          </div>
          <table>
            <thead><tr>{DAY_LETTERS.map((d, i) => <th key={i} style={{ padding: 2, fontSize: 10 }}>{d}</th>)}</tr></thead>
            <tbody>
              {calendarWeeks.map((week, wi) => (
                <tr key={wi}>
                  {week.map((d, di) => {
                    if (!d) return <td key={di} />;
                    const inWindow = !planWindow || (d >= planWindow.start && d <= planWindow.end);
                    const past = isDatePastClient(d);
                    const count = monthConfigs[d]?.hours?.length || 0;
                    const isSelected = d === selectedDate;
                    const isToday = d === todayIso();
                    return (
                      <td key={di} style={{ padding: 2 }}>
                        <button
                          onClick={() => inWindow && setSelectedDate(d)}
                          disabled={!inWindow}
                          title={!inWindow ? "Outside your access window" : past ? "In the past — view only" : isToday ? "Today — you can still set hours for the rest of the day" : `${count} half-hour block(s) open`}
                          style={{
                            width: 26, height: 24, fontSize: 11, borderRadius: 4, border: isToday ? "1.5px solid #0F5FBF" : "1px solid #DCE4EA",
                            background: isSelected ? "#0F5FBF" : count > 0 ? "#E4F0FB" : "#fff",
                            color: isSelected ? "#fff" : !inWindow ? "#DCE4EA" : "#1B2733",
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
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 13 }}>
              {selectedDate}
              {selectedIsPast && <span className="muted" style={{ fontWeight: 400 }}> (in the past)</span>}
              {selectedIsToday && <span className="muted" style={{ fontWeight: 400 }}> (today — already-passed hours are locked, the rest is editable)</span>}
            </strong>
            <div className="row">
              {saveStatus === "saving" && <span className="muted" style={{ fontSize: 12 }}>Saving…</span>}
              {saveStatus === "saved" && <span style={{ fontSize: 12, color: "#14803C" }}>✓ Saved</span>}
              {saveStatus === "error" && <span style={{ fontSize: 12, color: "#C22A1E" }}>Save failed</span>}
              {!selectedIsPast && (
                <>
                  <button className="btn-outline" onClick={fillNineToFive}>Set 9–5</button>
                  <button className="btn-outline" onClick={clearDay}>Clear day</button>
                </>
              )}
            </div>
          </div>
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
                  style={{ cursor: editable ? "pointer" : "default", background: open ? "#0F5FBF" : "#F2F6F9", color: open ? "#fff" : "#1B2733", opacity: editable ? 1 : 0.5 }}
                >
                  {formatTime(h)}
                </span>
              );
            })}
          </div>
          <div className="row">
            <span className="muted">Staff:</span>
            <input className="input" style={{ width: 60 }} type="number" min={1} disabled={selectedIsPast} value={staffCount} onChange={(e) => saveNow({ staffCount: Math.max(1, Number(e.target.value) || 1) })} />
            {service.mode === "hybrid" && (
              <>
                <span className="muted">On bookings:</span>
                <input className="input" style={{ width: 60 }} type="number" min={0} disabled={selectedIsPast} value={bookingStaffCount} onChange={(e) => saveNow({ bookingStaffCount: Math.max(0, Number(e.target.value) || 0) })} />
              </>
            )}
          </div>
          {!selectedIsPast && (
            <div className="wrap">
              <span className="muted" style={{ fontSize: 12 }}>Copy to:</span>
              <button className="btn-outline" onClick={copyToWeek}>Rest of week</button>
              <button className="btn-outline" onClick={copyToMonth}>Rest of month</button>
              <button className="btn-outline" onClick={copyToWholePeriod}>Whole paid period</button>
            </div>
          )}
          <div className="wrap">
            <span className="muted" style={{ fontSize: 12 }}>Danger zone:</span>
            <button className="btn-outline" style={{ color: "#C22A1E" }} onClick={clearAllDays}>Clear all days</button>
          </div>
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

function ServiceWizard({ locationId, onDone, onCancel, setError }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [creating, setCreating] = useState(false);
  const [createdService, setCreatedService] = useState(null);

  const needsSlotLength = mode === "appointment" || mode === "hybrid";

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
      <div className="card stack" style={{ background: "#E4F0FB", border: "1px solid #0F5FBF" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>New service — step 1 of 2</div>
        <input className="input" autoFocus placeholder="Service name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="stack">
          {SERVICE_MODE_INFO.map((m) => (
            <label key={m.id} className="card row" style={{ cursor: "pointer", alignItems: "flex-start", background: mode === m.id ? "#fff" : "transparent", borderColor: mode === m.id ? "#0F5FBF" : undefined }}>
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
        <div className="muted" style={{ fontSize: 11 }}>The name, type, and slot length can't be changed after this step — delete and recreate the service if you need to change them later.</div>
        <div className="row">
          <button className="btn" disabled={!name.trim() || creating} onClick={next}>{creating ? "Creating…" : "Next: set hours →"}</button>
          <button className="btn-outline" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card stack" style={{ background: "#E4F0FB", border: "1px solid #0F5FBF" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>New service — step 2 of 2: set hours for "{createdService.name}"</div>
      </div>
      <ServiceCalendar service={createdService} setError={setError} />
      <div className="row">
        <button className="btn" onClick={() => onDone(createdService)}>Done</button>
      </div>
    </div>
  );
}
