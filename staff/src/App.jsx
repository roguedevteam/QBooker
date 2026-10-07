import { useState, useEffect } from "react";
import { api, setToken, hasToken } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";
import TodayPanel from "./TodayPanel.jsx";

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatClock(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function formatTime(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

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
  const [tenant, setTenant] = useState(null);
  const [staff, setStaff] = useState(null); // { id, firstName, lastName }
  const [locationId, setLocationId] = useState(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    async function restore() {
      await refreshClock();
      if (hasToken()) {
        try {
          const r = await api.me();
          setTenant(r.tenant);
          setStaff(r.staff);
        } catch {
          setToken(null);
        }
      }
      setRestoring(false);
    }
    restore();
  }, []);

  if (restoring) return <div className="container muted center-text">Loading…</div>;

  return (
    <div>
      <header className="app-header">
        <div className="app-header-left">
          <Logo dark />
          {tenant && <span className="sub">{tenant.business_name}<span className="hide-sm"> Staff Kiosk</span></span>}
        </div>
        <div className="row">
          {tenant && staff && <span className="sub hide-sm">Signed in as {staff.firstName} {staff.lastName}</span>}
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
        </div>
      </header>
      {error && <div className="alert" role="alert"><span>{error}</span><button className="btn-outline" onClick={() => setError("")}>Dismiss</button></div>}

      {!tenant && <StaffLogin onSignedIn={(t, st) => { setTenant(t); setStaff(st); }} setError={setError} />}
      {tenant && !locationId && <LocationPicker staff={staff} onPick={setLocationId} onSignOut={() => { setToken(null); setTenant(null); setStaff(null); }} setError={setError} />}
      {tenant && locationId && <StaffKiosk tenant={tenant} staff={staff} locationId={locationId} setError={setError} onSignOut={() => { setToken(null); setTenant(null); setStaff(null); setLocationId(null); }} />}
    </div>
  );
}

function StaffLogin({ onSignedIn, setError }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [demoOtp, setDemoOtp] = useState(null);

  async function sendCode() {
    setError("");
    try { const r = await api.requestStaffOtp(email); setDemoOtp(r.demoOtp || null); setStep("otp"); } catch (err) { setError(err.message); }
  }
  async function verify() {
    setError("");
    try {
      const r = await api.verifyStaffOtp(email, otp);
      setToken(r.token);
      onSignedIn(r.tenant, r.staff);
    } catch (err) { setError(err.message); }
  }

  return (
    <main className="narrow">
      <div className="card stack">
        <h1>Staff sign-in</h1>
        <p className="muted">Sign in with the email address your manager added you with. We'll send you a code.</p>
        {step === "email" && <>
          <div>
            <label className="field-label" htmlFor="staff-email">Email address</label>
            <input id="staff-email" className="input" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && email.trim()) sendCode(); }} />
          </div>
          <button className="btn btn-primary" disabled={!email.trim()} onClick={sendCode}>Send code</button>
        </>}
        {step === "otp" && <>
          <div className="muted">If that email is registered, a code has been sent to it.</div>
          {demoOtp && <div className="muted">Demo code: <strong>{demoOtp}</strong></div>}
          <div>
            <label className="field-label" htmlFor="staff-otp">6-digit code</label>
            <input id="staff-otp" className="input mono" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && otp.trim()) verify(); }} />
          </div>
          <div className="wrap">
            <button className="btn btn-primary" disabled={!otp.trim()} onClick={verify}>Verify</button>
            <button className="btn-outline" onClick={() => { setStep("email"); setOtp(""); }}>Use a different email</button>
          </div>
        </>}
      </div>
    </main>
  );
}

// After signing in, staff choose which location they're working at today (one location is picked automatically).
function LocationPicker({ staff, onPick, onSignOut, setError }) {
  const [locations, setLocations] = useState(null);
  useEffect(() => {
    api.getLocations().then((r) => {
      const active = r.locations.filter((l) => !l.archived);
      setLocations(active);
      if (active.length === 1) onPick(active[0].id);
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!locations) return <div className="container muted center-text">Loading…</div>;
  return (
    <main className="setup">
      <div>
        <h1>Hi {staff?.firstName}, where are you working today?</h1>
        <p className="muted" style={{ marginTop: 4 }}>Choose your location to start your shift.</p>
      </div>
      {locations.length === 0 && <div className="muted">No locations have been set up yet — ask your manager.</div>}
      <div className="opts">
        {locations.map((l) => <button key={l.id} type="button" className="opt" onClick={() => onPick(l.id)}>{l.name}</button>)}
      </div>
      <div><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
    </main>
  );
}

const ROLE_LABELS = { queue: "Queue", appointments: "Appointments", both: "Both" };

function StaffKiosk({ tenant, staff, locationId, setError, onSignOut }) {
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceIds, setServiceIds] = useState([]);
  const [roles, setRoles] = useState({}); // serviceId -> "queue" | "appointments" | "both" (hybrid services only)
  const [showSeen, setShowSeen] = useState(false);
  const [showToday, setShowToday] = useState(false);
  const [started, setStarted] = useState(false);
  const [room, setRoom] = useState("");
  const [calling, setCalling] = useState(false); // a call/close request is in flight
  const [tickets, setTickets] = useState([]);
  const date = todayIso();

  useEffect(() => {
    Promise.all([api.getLocations(), api.getServices()]).then(([l, s]) => { setLocations(l.locations); setServices(s.services); }).catch((e) => setError(e.message));
  }, []);

  async function refreshTickets() {
    try { const r = await api.getTickets(date); setTickets(r.tickets); } catch (err) { setError(err.message); }
  }
  useEffect(() => {
    if (!started) return;
    refreshTickets();
    const id = setInterval(refreshTickets, 8000); // polling, not a live subscription
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  if (!locationId) {
    return <div className="narrow"><div className="card" style={{ color: "var(--error)" }}>This sign-in code isn't linked to a location — please check with your manager.</div></div>;
  }

  const locServices = services.filter((s) => s.location_id === locationId);
  const locationName = locations.find((l) => l.id === locationId)?.name;
  if (!started) {
    return (
      <main className="setup">
        <div>
          <h1>Start your shift</h1>
          <p className="muted" style={{ marginTop: 4 }}>{locationName ? `You are working at ${locationName}. ` : ""}Choose the services you are covering.</p>
        </div>
        <div className="setup-grid">
          <fieldset>
            <legend className="field-label">Which services are you covering?</legend>
            <div className="opts">
              {locServices.map((s) => (
                <div key={s.id}>
                  <label className="opt">
                    <input type="checkbox" checked={serviceIds.includes(s.id)} onChange={(e) => setServiceIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id))} />
                    <span className="box" aria-hidden="true" />{s.name}
                  </label>
                  {serviceIds.includes(s.id) && s.mode === "hybrid" && (
                    <fieldset className="role-pick">
                      <legend className="field-hint" style={{ marginTop: 0, marginBottom: 6 }}>You'll work on {s.name}:</legend>
                      <div className="seg-group">
                        {[["queue", "Queue"], ["appointments", "Appointments"], ["both", "Both"]].map(([val, label]) => (
                          <label key={val} className="seg">
                            <input type="radio" name={`role-${s.id}`} checked={(roles[s.id] || "both") === val} onChange={() => setRoles((prev) => ({ ...prev, [s.id]: val }))} />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                </div>
              ))}
              {locServices.length === 0 && <div className="muted">No services are set up at this location yet.</div>}
            </div>
          </fieldset>
          <div>
            <label className="field-label" htmlFor="room-setup">Room or desk name</label>
            <input id="room-setup" className="input" style={{ minHeight: 56 }} placeholder="e.g. Room 1, Bay 6…" value={room} onChange={(e) => setRoom(e.target.value)} />
            <div className="field-hint">People are told to go here when you call them. You can set this later too.</div>
          </div>
        </div>
        <button className="btn btn-start btn-block" disabled={serviceIds.length === 0} onClick={() => setStarted(true)}>Start shift</button>
      </main>
    );
  }

  async function callNext(serviceId) {
    try {
      setCalling(true);
      await api.callNext(serviceId, { date, clockMinutes: nowMinutes(), roomLabel: room, workType: workTypeFor(serviceId) });
      await refreshTickets();
    } catch (err) {
      // Someone else got there first (or the queue just emptied) — not an error worth shouting about.
      if (err.message === "Nobody left to call.") await refreshTickets(); else setError(err.message);
    } finally { setCalling(false); }
  }
  // Call a specific ticket out of turn from the list below.
  async function callSpecific(t) {
    try {
      setCalling(true);
      await api.callTicket(t.id, { roomLabel: room });
      await refreshTickets();
    } catch (err) { setError(err.message); await refreshTickets(); } finally { setCalling(false); }
  }
  // Is there anyone the "Call next" button could actually call right now? Mirrors the server's rule.
  function workTypeFor(serviceId) {
    const svc = services.find((x) => x.id === serviceId);
    if (svc?.mode === "queue") return "queue";
    if (svc?.mode === "appointment") return "appointments";
    return roles[serviceId] || "both";
  }
  function callable(t, serviceId, mins) {
    const wt = workTypeFor(serviceId);
    return t.service_id === serviceId && ((wt !== "appointments" && t.type === "walk_in" && t.status === "waiting") || (wt !== "queue" && t.type === "booked" && t.status === "booked" && t.slot_time <= mins));
  }
  function hasWaiting(serviceId) {
    const mins = nowMinutes();
    return tickets.some((t) => callable(t, serviceId, mins));
  }
  const roomSet = !!room.trim();
  // One person at a time: until the current ticket is closed (or returned, cancelled, no-show,
  // routed), staff can't call anyone else.
  // Who is being served is kept on the server (ticket.called_room), not in this browser, so a
  // staff member whose browser closed picks straight back up by entering the same room name.
  const inProgress = tickets.filter((t) => t.status === "serving" && locServices.some((x) => x.id === t.service_id));
  const mine = inProgress.filter((t) => t.called_by_staff_id === staff?.id);
  const nowServing = Object.fromEntries(mine.map((t) => [t.service_id, t]));
  const busy = mine.length > 0;
  const canCall = roomSet && !busy && !calling;
  async function doAction(fn) {
    try { setCalling(true); await fn(); await refreshTickets(); } catch (err) { setError(err.message); } finally { setCalling(false); }
  }

  const myTickets = tickets.filter((t) => serviceIds.includes(t.service_id));
  // Waiting list in the order "Call next" would take people: due appointments by slot time,
  // then walk-ins by arrival, then appointments that aren't due yet (earliest first).
  const nowMin = nowMinutes();
  const rank = (t) => (t.type === "booked" ? (t.slot_time <= nowMin ? [0, t.slot_time] : [2, t.slot_time]) : [1, new Date(t.created_at).getTime()]);
  const waitingList = myTickets.filter((t) => t.status === "waiting" || t.status === "booked")
    .sort((a, b) => { const [ra, va] = rank(a); const [rb, vb] = rank(b); return ra - rb || va - vb; });
  const doneList = myTickets.filter((t) => !(t.status === "waiting" || t.status === "booked"))
    .sort((a, b) => new Date(b.called_at || b.created_at) - new Date(a.called_at || a.created_at));
  const showServiceCol = serviceIds.length > 1;
  const svcName = (id) => services.find((x) => x.id === id)?.name || "—";
  const activeServices = locServices.filter((s) => serviceIds.includes(s.id) || nowServing[s.id]);
  const servingServices = activeServices.filter((s) => nowServing[s.id]);
  const nextFor = (serviceId) => waitingList.find((t) => callable(t, serviceId, nowMin));

  const covered = locServices.filter((s) => serviceIds.includes(s.id));
  const modeText = [...new Set(covered.map((s) => ROLE_LABELS[workTypeFor(s.id)]))].join(" / ");
  const ctxParts = [locationName, covered.map((s) => s.name).join(", "), room.trim() || "No room set", modeText].filter(Boolean);
  const callNote = !roomSet ? "Set your room name to start calling tickets." : busy ? "Close this ticket to call the next person." : "";

  return (
    <>
      <div className="kiosk-bar">
        <div className="who">
          <div className="name">{staff ? `${staff.firstName} ${staff.lastName}` : tenant?.business_name}</div>
          <div className="ctx">{ctxParts.join(" · ")}</div>
        </div>
        <div className="chips">
          {ctxParts.map((p, i) => <span key={i} className={`chip${!roomSet && p === "No room set" ? " chip-warn" : ""}`}>{p}</span>)}
        </div>
        {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {date}</span>}
        <button className="btn-signout" disabled={busy} title={busy ? "Close your ticket first" : undefined} onClick={onSignOut}>Sign out</button>
      </div>

      <main className="kiosk-main">
        <div className="col">
          {servingServices.map((s) => {
            const serving = nowServing[s.id];
            const others = locServices.filter((x) => x.id !== s.id);
            return (
              <section key={s.id} className="serving" aria-label={`Now serving, ${s.name}`}>
                <div className="top">
                  <span className="badge badge-blue">Now serving</span>
                  <span className="when">{serving.called_at ? `Called ${formatClock(serving.called_at)}` : ""}{room.trim() ? `${serving.called_at ? " · " : ""}${room.trim()}` : ""}</span>
                </div>
                <div className="ticket mono">{serving.ticket_number}</div>
                <div className="svc">{s.name} <span className="muted">· {serving.type === "booked" ? `Booked ${formatTime(serving.slot_time)}` : "Walk-in"}</span></div>
                <button className="btn-primary" disabled={calling} onClick={() => doAction(() => api.closeTicket(serving.id))}>Close ticket</button>
                <div className="pair">
                  <button className="btn-outline" onClick={() => doAction(() => api.returnToQueue(serving.id, { clockMinutes: nowMinutes() }))}>Put back in queue</button>
                  <button className="btn-outline btn-danger" onClick={() => doAction(() => api.noShowTicket(serving.id))}>Mark no show</button>
                </div>
                <div className="pair">
                  <button className="btn-outline" disabled={!roomSet} onClick={async () => { try { await api.callAgain(serving.id, { roomLabel: room }); } catch (err) { setError(err.message); } }}>Call again</button>
                  <button className="btn-outline btn-danger" onClick={() => doAction(() => api.cancelTicket(serving.id))}>Cancel ticket</button>
                </div>
                {others.length > 0 && (
                  <select className="select" aria-label="Route to another service" defaultValue="" onChange={(e) => { if (e.target.value) doAction(() => api.routeTicket(serving.id, { newServiceId: e.target.value, clockMinutes: nowMinutes() })); }}>
                    <option value="">Route to service…</option>
                    {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                )}
              </section>
            );
          })}

          {activeServices.map((s) => {
            const next = nextFor(s.id);
            const enabled = canCall && hasWaiting(s.id);
            return (
              <button key={s.id} className="btn-accent btn-call-next" disabled={!enabled} aria-describedby={callNote ? "call-note" : undefined} onClick={() => callNext(s.id)}>
                <span>{enabled && next ? <>Call next: <span className="mono">{next.ticket_number}</span></> : (roomSet && !busy && !hasWaiting(s.id)) ? "No tickets waiting" : "Call next"}</span>
                {activeServices.length > 1 && <span className="sub">{s.name}</span>}
              </button>
            );
          })}
          {callNote && <div id="call-note" className={`note${!roomSet ? " note-warn" : ""}`}>{callNote}</div>}

          <div className="card room-card">
            <label htmlFor="room">Where are you right now?</label>
            <input id="room" className={`input${roomSet ? "" : " input-warn"}`} placeholder="e.g. Room 1, Bay 6…" value={room} onChange={(e) => setRoom(e.target.value)} />
          </div>
        </div>

        <div className="col">
          <section className="panel" aria-labelledby="waiting-h">
            <div className="panel-head">
              <h2 id="waiting-h">Waiting</h2>
              <span className="count">{waitingList.length} in order of call</span>
              <button className="btn-outline" style={{ marginLeft: "auto" }} onClick={refreshTickets}>Refresh</button>
            </div>
            {waitingList.length === 0 && <div className="empty">Nobody waiting.</div>}
            <div role="list">
              {waitingList.map((t, i) => (
                <div key={t.id} className="wrow" role="listitem">
                  <span className="pos mono">{i + 1}</span>
                  <span className="tn mono">{t.ticket_number}</span>
                  <span className="info">
                    {showServiceCol ? svcName(t.service_id) : (t.type === "booked" ? "Booked" : "Walk-in")}
                    <small>
                      {t.type === "booked" ? `Booked ${formatTime(t.slot_time)}` : `Walk-in, joined ${formatClock(t.created_at)}`}
                      {t.type === "booked" && t.slot_time > nowMin ? " (not due yet)" : ""}
                    </small>
                    {t.type === "booked" && t.arrived_at && <span className="badge badge-green" style={{ marginTop: 4 }}>Checked in {formatClock(t.arrived_at)}</span>}
                  </span>
                  <button className="btn-call" disabled={!canCall} title={!roomSet ? "Set your room first" : busy ? "Close your ticket first" : undefined} aria-label={`Call ${t.ticket_number}`} onClick={() => callSpecific(t)}>Call</button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <button type="button" className="done-toggle" onClick={() => setShowToday((v) => !v)} aria-expanded={showToday} aria-controls="today-panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 9l7 7 7-7" /></svg>
              <span className="grow">Today: bookings and capacity</span>
            </button>
            {showToday && (
              <div id="today-panel" className="today-wrap">
                <TodayPanel embedded services={covered.map((x) => ({ id: x.id, name: x.name }))} />
              </div>
            )}
          </section>

          <section className="panel">
            <button type="button" className="done-toggle" onClick={() => setShowSeen((v) => !v)} aria-expanded={showSeen} aria-controls="done-list">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 9l7 7 7-7" /></svg>
              <span className="grow">Completed and closed today</span>
              <span className="count">{doneList.length}</span>
            </button>
            {showSeen && (
              <div id="done-list" className="done-wrap">
                <table className="done-table">
                  <thead><tr><th>Ticket</th>{showServiceCol && <th>Service</th>}<th>Booked / joined</th><th>Called</th><th>Finished</th><th>Served by</th><th>Status</th></tr></thead>
                  <tbody>
                    {doneList.length === 0 && <tr><td colSpan={showServiceCol ? 7 : 6} className="empty empty-cell">Nobody completed yet today.</td></tr>}
                    {doneList.map((t) => (
                      <tr key={t.id}>
                        <td className="tn tn-cell mono">{t.ticket_number}</td>
                        {showServiceCol && <td data-label="Service">{svcName(t.service_id)}</td>}
                        <td data-label="Booked / joined">{t.type === "booked" ? `Booked for ${formatTime(t.slot_time)}` : `Joined ${formatClock(t.created_at)}`}</td>
                        <td data-label="Called">{t.called_at ? formatClock(t.called_at) : "—"}</td>
                        <td data-label="Finished">{t.closed_by_system ? <span className="badge badge-amber">System closed</span> : t.finished_at ? formatClock(t.finished_at) : t.status === "serving" ? "In progress" : "—"}</td>
                        <td data-label="Served by">{t.called_by_name || "—"}</td>
                        <td data-label="Status"><span className={`badge badge-${t.status === "completed" ? "green" : t.status === "serving" ? "amber" : "red"}`}>{t.status === "no_show" ? "no-show" : t.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
