import { useState, useEffect } from "react";
import { api, setToken, hasToken } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

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
        <strong>{tenant ? `${tenant.business_name} — Staff Kiosk` : "QBooker Staff Kiosk"}</strong>
        {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#C22A1E", color: "#C22A1E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

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
  const [started, setStarted] = useState(false);
  const [room, setRoom] = useState("");
  const [nowServing, setNowServing] = useState({}); // serviceId -> ticket object
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
    return <div className="narrow card" style={{ color: "#C22A1E" }}>This sign-in code isn't linked to a location — please check with your manager.</div>;
  }

  const locServices = services.filter((s) => s.location_id === locationId);
  if (!started) {
    return (
      <div className="narrow card stack">
        <h3>Which services are you covering?</h3>
        {locServices.map((s) => (
          <label key={s.id} className="row"><input type="checkbox" onChange={(e) => setServiceIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id))} /> {s.name}</label>
        ))}
        <button className="btn" disabled={serviceIds.length === 0} onClick={() => setStarted(true)}>Start shift</button>
      </div>
    );
  }

  async function callNext(serviceId) {
    try {
      const r = await api.callNext(serviceId, { date, clockMinutes: nowMinutes(), roomLabel: room });
      setNowServing((prev) => ({ ...prev, [serviceId]: r.ticket }));
      refreshTickets();
    } catch (err) { setError(err.message); }
  }
  async function doAction(fn, serviceId) {
    try { await fn(); setNowServing((prev) => { const next = { ...prev }; delete next[serviceId]; return next; }); refreshTickets(); } catch (err) { setError(err.message); }
  }

  const myTickets = tickets.filter((t) => serviceIds.includes(t.service_id));
  const showServiceCol = serviceIds.length > 1;

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">{locations.find((l) => l.id === locationId)?.name}</span><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
      <div className="card row" style={{ background: room.trim() ? "#E4F0FB" : "#FBE9E7" }}>
        <span style={{ color: room.trim() ? "#0F5FBF" : "#C22A1E", fontSize: 13 }}>Where are you right now?</span>
        <input className="input" style={{ borderColor: room.trim() ? "#DCE4EA" : "#C22A1E" }} placeholder="e.g. Room 1, Bay 6…" value={room} onChange={(e) => setRoom(e.target.value)} />
      </div>
      {!room.trim() && <div className="muted" style={{ fontSize: 11, color: "#C22A1E" }}>Not set — customers you call will be told no location has been given yet.</div>}

      {locServices.filter((s) => serviceIds.includes(s.id)).map((s) => {
        const serving = nowServing[s.id];
        return (
          <div key={s.id} className="card stack">
            <div>{s.name}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0F5FBF" }}>{serving?.ticket_number || "—"}</div>
            {serving && <div style={{ fontSize: 13 }}>{room.trim() ? `📍 ${room.trim()}` : "Now serving"}</div>}
            <button className="btn" onClick={() => callNext(s.id)}>Call next ticket</button>
            {serving && (
              <div className="stack">
                <button className="btn" style={{ background: "#14803C" }} onClick={() => doAction(() => api.closeTicket(serving.id), s.id)}>Close ticket — finished serving</button>
                <div className="row">
                  <button className="btn-outline" style={{ flex: 1 }} onClick={() => doAction(() => api.returnToQueue(serving.id, { clockMinutes: nowMinutes() }), s.id)}>Return to queue</button>
                  <button className="btn-outline" style={{ flex: 1, color: "#C22A1E" }} onClick={() => doAction(() => api.cancelTicket(serving.id), s.id)}>Cancel ticket</button>
                </div>
                <div className="row">
                  <button className="btn-outline" style={{ flex: 1 }} onClick={async () => { try { await api.callAgain(serving.id, { roomLabel: room }); } catch (err) { setError(err.message); } }}>Call again</button>
                  {locServices.filter((x) => x.id !== s.id).length > 0 && (
                    <select style={{ flex: 1 }} defaultValue="" onChange={(e) => { if (e.target.value) doAction(() => api.routeTicket(serving.id, { newServiceId: e.target.value, clockMinutes: nowMinutes() }), s.id); }}>
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

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 13 }}>Today's tickets &amp; appointments</strong><button className="btn-outline" onClick={refreshTickets}>Refresh</button></div>
        <table>
          <thead><tr><th>Ticket</th>{showServiceCol && <th>Service</th>}<th>Type/time</th><th>Status</th></tr></thead>
          <tbody>
            {myTickets.length === 0 && <tr><td colSpan={showServiceCol ? 4 : 3} className="muted" style={{ textAlign: "center", padding: 12 }}>Nothing yet today.</td></tr>}
            {myTickets.map((t) => (
              <tr key={t.id}>
                <td>{t.ticket_number}</td>
                {showServiceCol && <td>{services.find((s) => s.id === t.service_id)?.name || "—"}</td>}
                <td>{t.type === "booked" ? formatTime(t.slot_time) : "Walk-in"}</td>
                <td><span className={`badge badge-${t.status === "seen" ? "green" : t.status === "cancelled" || t.status === "no_show" ? "red" : "blue"}`}>{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
