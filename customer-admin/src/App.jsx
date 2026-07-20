import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
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

// ---------------------------------------------------------------------------
function PlanBanner({ tenant, setError, onChanged }) {
  const [plan, setPlan] = useState(null);
  const [draft, setDraft] = useState("");

  async function load() {
    try { const r = await api.getPlan(); setPlan(r); setDraft(r.window?.start || ""); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function reschedule() {
    try {
      const payload = tenant.plan_id === "day" ? { activeDate: draft } : tenant.plan_id === "week" ? { weekStartDate: draft } : { startDate: draft };
      await api.reschedulePlan(payload);
      await load();
      onChanged?.();
    } catch (err) { setError(err.message); }
  }

  if (!plan || !plan.window) return null;
  const label = tenant.plan_id === "day" ? "Day pass"
    : tenant.plan_id === "week" ? "Week pass"
    : tenant.plan_label;

  return (
    <div className="card row" style={{ justifyContent: "space-between", background: plan.locked ? "#FBE9E7" : "#E4F0FB", flexWrap: "wrap" }}>
      <div style={{ fontSize: 13 }}>
        <strong>{label}</strong> covers <strong>{plan.window.start}</strong> to <strong>{plan.window.end}</strong>
        {plan.locked ? " — locked (already started)." : "."}
      </div>
      {!plan.locked && (
        <div className="row">
          <span className="muted" style={{ fontSize: 12 }}>Reschedule to:</span>
          <input className="input" type="date" min={todayIso()} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 150 }} />
          <button className="btn-outline" onClick={reschedule}>Save</button>
        </div>
      )}
    </div>
  );
}

function AdminDashboard({ tenant, setError, onSignOut }) {
  const [tab, setTab] = useState("locations");
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [buyingLocation, setBuyingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [expandedLocations, setExpandedLocations] = useState({});
  const [addingServiceFor, setAddingServiceFor] = useState(null);
  const [newServiceDraft, setNewServiceDraft] = useState("");
  const [tickets, setTickets] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const date = todayIso();
  const STAFF_APP_URL = import.meta.env.VITE_STAFF_APP_URL || "http://localhost:5176";
  const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
  const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || "+447000000000";
  const widgetSnippet = `<script src="${API_URL}/widget.js" data-tenant="${tenant.id}" data-whatsapp="${WHATSAPP_NUMBER}" async></script>`;

  async function refreshCore() {
    try {
      const [locRes, svcRes] = await Promise.all([api.getLocations(), api.getServices()]);
      setLocations(locRes.locations); setServices(svcRes.services);
    } catch (err) { setError(err.message); }
  }
  async function refreshQueue() {
    try {
      const tixRes = await api.getTickets(date);
      setTickets(tixRes.tickets);
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
      <PlanBanner tenant={tenant} setError={setError} />
      <div className="wrap">
        {["locations", "queue", "audit"].map((t) => (
          <button key={t} className={tab === t ? "btn" : "btn-outline"} onClick={() => { setTab(t); if (t === "queue") refreshQueue(); if (t === "audit") refreshAudit(); }}>{t}</button>
        ))}
      </div>

      {tab === "locations" && (
        <div className="stack">
          <div className="card stack" style={{ background: "#E4F0FB" }}>
            <div style={{ fontSize: 13 }}>Staff access code: <strong style={{ letterSpacing: 1 }}>{tenant.access_code}</strong></div>
            <div className="muted" style={{ fontSize: 12 }}>
              Give your team the Staff Kiosk link ({STAFF_APP_URL}) and this code, plus the one-time code they'll get when they sign in.
            </div>
          </div>
          <div className="card stack">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Website widget</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Paste this onto your own website — it lists your locations and links straight to WhatsApp for each one.
              Update the WhatsApp number in your deployment settings once you have a real one (<code>VITE_WHATSAPP_NUMBER</code>).
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <code style={{ fontSize: 11, background: "#F2F6F9", padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{widgetSnippet}</code>
              <button className="btn-outline" onClick={() => { navigator.clipboard?.writeText(widgetSnippet); }}>Copy</button>
            </div>
          </div>
          <div className="card row" style={{ justifyContent: "space-between" }}>
            <span>You're on <strong>{locations.length}</strong> location{locations.length === 1 ? "" : "s"}, paid as part of your {tenant.plan_label?.toLowerCase()}.</span>
            {!buyingLocation && <button className="btn" onClick={() => setBuyingLocation(true)}>Buy another location</button>}
          </div>
          {buyingLocation && (
            <div className="card stack" style={{ background: "#E4F0FB" }}>
              <div style={{ fontSize: 13 }}>
                Adding a location costs <strong>£{tenant.price_per_location}</strong> for your current plan
                {tenant.payment_method === "invoice" ? " — added to your next invoice." : " — charged to your card on file."}
              </div>
              <div className="row">
                <input className="input" placeholder="New location name" value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
                <button className="btn" disabled={!newLocationName.trim()} onClick={async () => { try { await api.addLocation(newLocationName); setNewLocationName(""); setBuyingLocation(false); refreshCore(); } catch (err) { setError(err.message); } }}>Buy &amp; add</button>
                <button className="btn-outline" onClick={() => { setBuyingLocation(false); setNewLocationName(""); }}>Cancel</button>
              </div>
            </div>
          )}
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
                    <strong>{loc.name}</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{locServices.length} service{locServices.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="row">
                    <button className="btn" onClick={() => { setAddingServiceFor(loc.id); setNewServiceDraft(""); setExpandedLocations((prev) => ({ ...prev, [loc.id]: true })); }}>Add service</button>
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

                {loc.code && <LocationWhatsApp code={loc.code} whatsappNumber={WHATSAPP_NUMBER} />}

                {addingHere && (
                  <div className="stack" style={{ position: "relative" }}>
                    <div className="card stack" style={{ background: "#E4F0FB", border: "1px solid #0F5FBF" }}>
                      <span className="muted" style={{ fontSize: 12 }}>New service at {loc.name}</span>
                      <div className="row">
                        <input
                          className="input" autoFocus placeholder="Service name" value={newServiceDraft}
                          onChange={(e) => setNewServiceDraft(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === "Enter" && newServiceDraft.trim()) {
                              await api.addService(newServiceDraft, loc.id);
                              setAddingServiceFor(null); setNewServiceDraft(""); refreshCore();
                            }
                            if (e.key === "Escape") { setAddingServiceFor(null); setNewServiceDraft(""); }
                          }}
                        />
                        <button
                          className="btn" disabled={!newServiceDraft.trim()}
                          onClick={async () => { await api.addService(newServiceDraft, loc.id); setAddingServiceFor(null); setNewServiceDraft(""); refreshCore(); }}
                        >
                          Add
                        </button>
                        <button className="btn-outline" onClick={() => { setAddingServiceFor(null); setNewServiceDraft(""); }}>Cancel</button>
                      </div>
                    </div>
                  </div>
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

      {tab === "queue" && (
        <div className="stack">
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn-outline" onClick={refreshQueue}>Refresh</button></div>
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

function LocationWhatsApp({ code, whatsappNumber }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const waLink = `https://wa.me/${whatsappNumber.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(code)}`;

  useEffect(() => {
    QRCode.toDataURL(waLink, { width: 120, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [waLink]);

  return (
    <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap", background: "#F2F6F9", borderRadius: 8, padding: 10 }}>
      {qrDataUrl && <img src={qrDataUrl} alt={`QR code for ${code}`} width={90} height={90} style={{ borderRadius: 4 }} />}
      <div className="stack" style={{ gap: 4 }}>
        <div style={{ fontSize: 12 }}>Location code: <strong style={{ letterSpacing: 1 }}>{code}</strong></div>
        <a href={waLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#0F5FBF" }}>{waLink}</a>
        <div className="row">
          <button className="btn-outline" onClick={() => navigator.clipboard?.writeText(waLink)}>Copy WhatsApp link</button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>Print this QR code for the location — scanning it opens WhatsApp with the code pre-filled.</div>
      </div>
    </div>
  );
}

function ServiceEditor({ service, onChange, setError }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [calendarMonth, setCalendarMonth] = useState(firstOfMonth(todayIso()));
  const [monthConfigs, setMonthConfigs] = useState({});
  const [planWindow, setPlanWindow] = useState(null);
  const [draftHours, setDraftHours] = useState([]);
  const [staffCount, setStaffCount] = useState(2);
  const [bookingStaffCount, setBookingStaffCount] = useState(1);

  const paintingRef = useRef(false);
  const paintModeRef = useRef(true);
  const draftHoursRef = useRef([]);
  const staffCountRef = useRef(2);
  const bookingRef = useRef(1);
  const selectedDateRef = useRef(selectedDate);

  useEffect(() => { draftHoursRef.current = draftHours; }, [draftHours]);
  useEffect(() => { staffCountRef.current = staffCount; }, [staffCount]);
  useEffect(() => { bookingRef.current = bookingStaffCount; }, [bookingStaffCount]);
  useEffect(() => { selectedDateRef.current = selectedDate; }, [selectedDate]);

  useEffect(() => {
    async function onUp() {
      if (paintingRef.current) {
        paintingRef.current = false;
        try {
          await api.putDailyConfig(service.id, {
            date: selectedDateRef.current, hours: draftHoursRef.current, staffCount: staffCountRef.current, bookingStaffCount: bookingRef.current,
          });
          setMonthConfigs((prev) => ({ ...prev, [selectedDateRef.current]: { date: selectedDateRef.current, hours: draftHoursRef.current, staff_count: staffCountRef.current, booking_staff_count: bookingRef.current } }));
        } catch (err) { setError(err.message); }
      }
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  async function loadMonth(monthStart) {
    if (!expanded) return;
    const monthEnd = addDaysIso(addMonthsIso(monthStart, 1), -1);
    try {
      const r = await api.getDailyConfig(service.id, monthStart, monthEnd);
      const map = {};
      r.dailyConfig.forEach((d) => { map[d.date] = d; });
      setMonthConfigs(map);
      setPlanWindow(r.window);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadMonth(calendarMonth); }, [calendarMonth, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const entry = monthConfigs[selectedDate];
    setDraftHours(entry?.hours || []);
    setStaffCount(entry?.staff_count ?? 2);
    setBookingStaffCount(entry?.booking_staff_count ?? 1);
  }, [selectedDate, monthConfigs]);

  const selectedLocked = isDateLockedClient(selectedDate);

  function applyHour(hourMin, open) {
    setDraftHours((prev) => {
      const has = prev.includes(hourMin);
      if (open && !has) return [...prev, hourMin].sort((a, b) => a - b);
      if (!open && has) return prev.filter((h) => h !== hourMin);
      return prev;
    });
  }
  function beginPaint(hourMin) {
    if (selectedLocked) return;
    const mode = !draftHours.includes(hourMin);
    paintingRef.current = true;
    paintModeRef.current = mode;
    applyHour(hourMin, mode);
  }
  function continuePaint(hourMin) {
    if (!paintingRef.current || selectedLocked) return;
    applyHour(hourMin, paintModeRef.current);
  }

  async function saveNow(patch) {
    const hours = patch.hours ?? draftHours;
    const nextStaff = patch.staffCount ?? staffCount;
    const nextBooking = patch.bookingStaffCount ?? bookingStaffCount;
    if (patch.hours) setDraftHours(patch.hours);
    if (patch.staffCount !== undefined) setStaffCount(patch.staffCount);
    if (patch.bookingStaffCount !== undefined) setBookingStaffCount(patch.bookingStaffCount);
    try {
      await api.putDailyConfig(service.id, { date: selectedDate, hours, staffCount: nextStaff, bookingStaffCount: nextBooking });
      setMonthConfigs((prev) => ({ ...prev, [selectedDate]: { date: selectedDate, hours, staff_count: nextStaff, booking_staff_count: nextBooking } }));
    } catch (err) { setError(err.message); }
  }

  function fillNineToFive() {
    const hours = [];
    for (let h = 540; h < 1020; h += 30) hours.push(h);
    saveNow({ hours });
  }
  function clearDay() { saveNow({ hours: [] }); }

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
  const configuredCount = Object.values(monthConfigs).filter((c) => c.hours?.length > 0).length;

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <input className="input" style={{ maxWidth: 220 }} value={service.name} onChange={async (e) => { await api.updateService(service.id, { name: e.target.value }); }} />
        {!expanded && <span className="muted" style={{ fontSize: 12 }}>{configuredCount} day(s) with hours this month</span>}
        <div className="row">
          <button className="btn-outline" onClick={async () => { await api.deleteService(service.id); onChange(); }}>Delete</button>
          <button className="btn-outline" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        </div>
      </div>

      <div className="wrap">
        <span className="muted">Booking type:</span>
        {["queue", "appointment", "hybrid"].map((m) => (
          <button key={m} className={service.mode === m ? "btn" : "btn-outline"} onClick={async () => { await api.updateService(service.id, { mode: m }); onChange(); }}>{m}</button>
        ))}
        {service.mode !== "queue" && (
          <>
            <span className="muted">Slot length:</span>
            <select value={service.slot_minutes} onChange={async (e) => { await api.updateService(service.id, { slotMinutes: Number(e.target.value) }); onChange(); }}>
              {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </>
        )}
      </div>

      {service.mode === "queue" ? (
        <div className="row">
          <button className="btn-outline" onClick={async () => { await api.updateService(service.id, { queuePaused: !service.queue_paused }); onChange(); }}>
            {service.queue_paused ? "Resume" : "Pause (busy)"}
          </button>
          <span className="muted">Staff working:</span>
          <input className="input" style={{ width: 70 }} type="number" min={1} value={service.queue_staff_count} onChange={async (e) => { await api.updateService(service.id, { queueStaffCount: Number(e.target.value) }); onChange(); }} />
        </div>
      ) : expanded && (
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
                        const locked = isDateLockedClient(d);
                        const count = monthConfigs[d]?.hours?.length || 0;
                        const isSelected = d === selectedDate;
                        const isToday = d === todayIso();
                        return (
                          <td key={di} style={{ padding: 2 }}>
                            <button
                              onClick={() => inWindow && setSelectedDate(d)}
                              disabled={!inWindow}
                              title={!inWindow ? "Outside your access window" : locked ? "Locked — view only" : `${count} half-hour block(s) open`}
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
                <strong style={{ fontSize: 13 }}>{selectedDate}{selectedLocked && <span className="muted" style={{ fontWeight: 400 }}> (locked)</span>}</strong>
                {!selectedLocked && (
                  <div className="row">
                    <button className="btn-outline" onClick={fillNineToFive}>Set 9–5</button>
                    <button className="btn-outline" onClick={clearDay}>Clear day</button>
                  </div>
                )}
              </div>
              <div className="wrap" style={{ userSelect: "none" }}>
                {GRID_HOURS.map((h) => {
                  const open = draftHours.includes(h);
                  return (
                    <span
                      key={h}
                      onMouseDown={() => beginPaint(h)}
                      onMouseEnter={() => continuePaint(h)}
                      className="badge"
                      style={{ cursor: selectedLocked ? "default" : "pointer", background: open ? "#0F5FBF" : "#F2F6F9", color: open ? "#fff" : "#1B2733", opacity: selectedLocked ? 0.6 : 1 }}
                    >
                      {formatTime(h)}
                    </span>
                  );
                })}
              </div>
              <div className="row">
                <span className="muted">Staff:</span>
                <input className="input" style={{ width: 60 }} type="number" min={1} disabled={selectedLocked} value={staffCount} onChange={(e) => saveNow({ staffCount: Math.max(1, Number(e.target.value) || 1) })} />
                {service.mode !== "appointment" && (
                  <>
                    <span className="muted">On bookings:</span>
                    <input className="input" style={{ width: 60 }} type="number" min={0} disabled={selectedLocked} value={bookingStaffCount} onChange={(e) => saveNow({ bookingStaffCount: Math.max(0, Number(e.target.value) || 0) })} />
                  </>
                )}
              </div>
              {!selectedLocked && (
                <div className="wrap">
                  <span className="muted" style={{ fontSize: 12 }}>Copy to:</span>
                  <button className="btn-outline" onClick={copyToWeek}>Rest of week</button>
                  <button className="btn-outline" onClick={copyToMonth}>Rest of month</button>
                  <button className="btn-outline" onClick={copyToWholePeriod}>Whole paid period</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
