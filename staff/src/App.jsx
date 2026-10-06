import { useState, useEffect } from "react";
import { api, setToken, hasToken } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

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
        <rect x="2" y="2" width="40" height="40" fill="var(--blue)" />
        <circle cx="42" cy="22" r="7" fill="var(--accent)" />
      </svg>
      <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>
    </span>
  );
}

export default function App() {
  const [tenant, setTenant] = useState(null);
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
          setLocationId(r.staffLocationId || null);
        } catch {
          setToken(null);
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
        <div className="row" style={{ gap: 10 }}>
          <Logo />
          {tenant && <span className="muted" style={{ fontSize: 13 }}>— {tenant.business_name} Staff Kiosk</span>}
        </div>
        {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#B3261E", color: "#B3261E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {!tenant && <StaffLogin onSignedIn={(t, locId) => { setTenant(t); setLocationId(locId); }} setError={setError} />}
      {tenant && <StaffKiosk tenant={tenant} locationId={locationId} setError={setError} onSignOut={() => { setToken(null); setTenant(null); setLocationId(null); }} />}
    </div>
  );
}

function StaffLogin({ onSignedIn, setError }) {
  const [step, setStep] = useState("code");
  const [accessCode, setAccessCode] = useState("");
  const [otp, setOtp] = useState("");
  const [demoOtp, setDemoOtp] = useState(null);

  async function sendCode() {
    setError("");
    try { const r = await api.requestStaffOtp(accessCode); setDemoOtp(r.demoOtp); setStep("otp"); } catch (err) { setError(err.message); }
  }
  async function verify() {
    setError("");
    try {
      const r = await api.verifyStaffOtp(accessCode, otp);
      setToken(r.token);
      onSignedIn(r.tenant, r.location?.id || null);
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="narrow card stack">
      <h3>Staff sign-in</h3>
      <p className="muted" style={{ fontSize: 12 }}>Use the sign-in code for your location — shown to your manager in the Locations tab.</p>
      {step === "code" && <><input className="input" placeholder="Access code" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} /><button className="btn" onClick={sendCode}>Continue</button></>}
      {step === "otp" && <>
        <div className="muted">Demo code: <strong>{demoOtp}</strong></div>
        <input className="input" placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value)} />
        <button className="btn" onClick={verify}>Verify</button>
      </>}
    </div>
  );
}

function StaffKiosk({ tenant, locationId, setError, onSignOut }) {
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceIds, setServiceIds] = useState([]);
  const [roles, setRoles] = useState({}); // serviceId -> "queue" | "appointments" | "both" (hybrid services only)
  const [showSeen, setShowSeen] = useState(false);
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
    return <div className="narrow card" style={{ color: "#B3261E" }}>This sign-in code isn't linked to a location — please check with your manager.</div>;
  }

  const locServices = services.filter((s) => s.location_id === locationId);
  if (!started) {
    return (
      <div className="narrow card stack">
        <h3>Which services are you covering?</h3>
        {locServices.map((s) => (
          <div key={s.id} className="stack" style={{ gap: 6 }}>
            <label className="row"><input type="checkbox" onChange={(e) => setServiceIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id))} /> {s.name}</label>
            {serviceIds.includes(s.id) && s.mode === "hybrid" && (
              <div className="row" style={{ marginLeft: 26, gap: 14, flexWrap: "wrap" }}>
                <span className="muted" style={{ fontSize: 12 }}>You'll work:</span>
                {[["queue", "Queue"], ["appointments", "Appointments"], ["both", "Both"]].map(([val, label]) => (
                  <label key={val} className="row" style={{ gap: 4, fontSize: 13 }}>
                    <input type="radio" name={`role-${s.id}`} checked={(roles[s.id] || "both") === val} onChange={() => setRoles((prev) => ({ ...prev, [s.id]: val }))} /> {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
        <button className="btn" disabled={serviceIds.length === 0} onClick={() => setStarted(true)}>Start shift</button>
      </div>
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
  // Pick up a ticket another room started serving (their browser closed, they left, etc.).
  async function takeOver(t) {
    try { setCalling(true); await api.takeOverTicket(t.id, { roomLabel: room }); await refreshTickets(); }
    catch (err) { setError(err.message); await refreshTickets(); } finally { setCalling(false); }
  }
  // Is there anyone the "Call next" button could actually call right now? Mirrors the server's rule.
  function workTypeFor(serviceId) {
    const svc = services.find((x) => x.id === serviceId);
    if (svc?.mode === "queue") return "queue";
    if (svc?.mode === "appointment") return "appointments";
    return roles[serviceId] || "both";
  }
  function hasWaiting(serviceId) {
    const mins = nowMinutes();
    const wt = workTypeFor(serviceId);
    return tickets.some((t) => t.service_id === serviceId && ((wt !== "appointments" && t.type === "walk_in" && t.status === "waiting") || (wt !== "queue" && t.type === "booked" && t.status === "booked" && t.slot_time <= mins)));
  }
  const roomSet = !!room.trim();
  // One person at a time: until the current ticket is closed (or returned, cancelled, no-show,
  // routed), staff can't call anyone else.
  // Who is being served is kept on the server (ticket.called_room), not in this browser, so a
  // staff member whose browser closed picks straight back up by entering the same room name.
  const norm = (x) => (x || "").trim().toLowerCase();
  const inProgress = tickets.filter((t) => t.status === "seen" && t.called_at && !t.finished_at && locServices.some((x) => x.id === t.service_id));
  const mine = roomSet ? inProgress.filter((t) => norm(t.called_room) === norm(room)) : [];
  const elsewhere = inProgress.filter((t) => !mine.includes(t));
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

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">{locations.find((l) => l.id === locationId)?.name}</span><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
      <div className="card row" style={{ background: room.trim() ? "#FBEEDD" : "#FBE9E7" }}>
        <span style={{ color: room.trim() ? "#1B1D1F" : "#B3261E", fontSize: 13 }}>Where are you right now?</span>
        <input className="input" style={{ borderColor: room.trim() ? "#DEDDD6" : "#B3261E" }} placeholder="e.g. Room 1, Bay 6…" value={room} onChange={(e) => setRoom(e.target.value)} />
      </div>
      {!room.trim() && <div className="muted" style={{ fontSize: 11, color: "#B3261E" }}>Set your room name to start calling tickets.</div>}

      {elsewhere.length > 0 && (
        <div className="card stack" style={{ borderColor: "var(--accent)" }}>
          <strong style={{ fontSize: 13 }}>In progress with another room</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            If one of these is yours (you closed the page or came back later), enter the same room name above and it will reappear here as yours. If the person has left, take it over to finish or release it.
          </div>
          {elsewhere.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: "space-between" }}>
              <span><strong>{t.ticket_number}</strong> · {services.find((x) => x.id === t.service_id)?.name} · {t.called_room || "no room"} · called {formatClock(t.called_at)}</span>
              <button className="btn-outline" disabled={!roomSet || busy || calling} onClick={() => takeOver(t)}>Take over</button>
            </div>
          ))}
        </div>
      )}

      {locServices.filter((s) => serviceIds.includes(s.id) || nowServing[s.id]).map((s) => {
        const serving = nowServing[s.id];
        return (
          <div key={s.id} className="card stack">
            <div>{s.name}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#1B1D1F" }}>{serving?.ticket_number || "—"}</div>
            {serving && <div style={{ fontSize: 13 }}>{room.trim() ? `📍 ${room.trim()}` : "Now serving"}</div>}
            <button className="btn" disabled={!canCall || !hasWaiting(s.id)} onClick={() => callNext(s.id)}>{!roomSet ? "Set your room to call tickets" : busy ? "Finish your current ticket first" : hasWaiting(s.id) ? "Call next ticket" : "No tickets waiting"}</button>
            {serving && (
              <div className="stack">
                <button className="btn" style={{ background: "#2F6F4E" }} onClick={() => doAction(() => api.closeTicket(serving.id))}>Close ticket — finished serving</button>
                <div className="row">
                  <button className="btn-outline" style={{ flex: 1 }} onClick={() => doAction(() => api.returnToQueue(serving.id, { clockMinutes: nowMinutes() }))}>Return to queue</button>
                  <button className="btn-outline" style={{ flex: 1, color: "#B3261E" }} onClick={() => doAction(() => api.noShowTicket(serving.id))}>No-show</button>
                  <button className="btn-outline" style={{ flex: 1, color: "#B3261E" }} onClick={() => doAction(() => api.cancelTicket(serving.id))}>Cancel ticket</button>
                </div>
                <div className="row">
                  <button className="btn-outline" style={{ flex: 1 }} disabled={!roomSet} onClick={async () => { try { await api.callAgain(serving.id, { roomLabel: room }); } catch (err) { setError(err.message); } }}>Call again</button>
                  {locServices.filter((x) => x.id !== s.id).length > 0 && (
                    <select style={{ flex: 1 }} defaultValue="" onChange={(e) => { if (e.target.value) doAction(() => api.routeTicket(serving.id, { newServiceId: e.target.value, clockMinutes: nowMinutes() })); }}>
                      <option value="">Route to service…</option>
                      {locServices.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 13 }}>Waiting — next to be called first</strong><button className="btn-outline" onClick={refreshTickets}>Refresh</button></div>
        <table>
          <thead><tr><th>#</th><th>Ticket</th>{showServiceCol && <th>Service</th>}<th>Type/time</th><th></th></tr></thead>
          <tbody>
            {waitingList.length === 0 && <tr><td colSpan={showServiceCol ? 5 : 4} className="muted" style={{ textAlign: "center", padding: 12 }}>Nobody waiting.</td></tr>}
            {waitingList.map((t, i) => (
              <tr key={t.id}>
                <td className="muted">{i + 1}</td>
                <td>{t.ticket_number}</td>
                {showServiceCol && <td>{services.find((x) => x.id === t.service_id)?.name || "—"}</td>}
                <td>
                  {t.type === "booked" ? `Booked ${formatTime(t.slot_time)}` : `Walk-in, joined ${formatClock(t.created_at)}`}
                  {t.type === "booked" && t.slot_time > nowMinutes() && <span className="muted" style={{ fontSize: 11 }}> (not due yet)</span>}
                </td>
                <td style={{ textAlign: "right" }}><button className="btn-outline" disabled={!canCall} title={!roomSet ? "Set your room first" : busy ? "Finish your current ticket first" : undefined} onClick={() => callSpecific(t)}>Call</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card stack">
        <button type="button" className="row" style={{ justifyContent: "space-between", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }} onClick={() => setShowSeen((v) => !v)} aria-expanded={showSeen}>
          <strong style={{ fontSize: 13 }}>Seen &amp; closed today ({doneList.length})</strong>
          <span className="muted" style={{ fontSize: 12 }}>{showSeen ? "Hide ▲" : "Show ▼"}</span>
        </button>
        {showSeen && (
          <table>
            <thead><tr><th>Ticket</th>{showServiceCol && <th>Service</th>}<th>Booked / joined</th><th>Called</th><th>Finished</th><th>Status</th></tr></thead>
            <tbody>
              {doneList.length === 0 && <tr><td colSpan={showServiceCol ? 6 : 5} className="muted" style={{ textAlign: "center", padding: 12 }}>Nobody seen yet today.</td></tr>}
              {doneList.map((t) => (
                <tr key={t.id}>
                  <td>{t.ticket_number}</td>
                  {showServiceCol && <td>{services.find((x) => x.id === t.service_id)?.name || "—"}</td>}
                  <td>{t.type === "booked" ? `Booked for ${formatTime(t.slot_time)}` : `Joined ${formatClock(t.created_at)}`}</td>
                  <td>{t.called_at ? formatClock(t.called_at) : "—"}</td>
                  <td>{t.finished_at ? formatClock(t.finished_at) : t.status === "seen" ? "In progress" : "—"}</td>
                  <td><span className={`badge badge-${t.status === "seen" ? "green" : "red"}`}>{t.status === "no_show" ? "no-show" : t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
