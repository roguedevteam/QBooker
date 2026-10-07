import { useState, useEffect, useRef } from "react";
import { api } from "./lib/api.js";
import { todayIso, isSimulatedToday } from "./lib/clock.js";
import { nowMinutes, formatClock, formatTime, formatElapsed, minutesSince, loadPref, savePref } from "./lib/util.js";
import TodayPanel from "./TodayPanel.jsx";

const ROOM_KEY = "qb_staff_room";
const SERVICES_KEY = "qb_staff_services";
const ROLES_KEY = "qb_staff_roles";

function useMedia(query) {
  const [m, setM] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const h = (e) => setM(e.matches);
    setM(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return m;
}

// Who is in the Waiting step: walk-ins that are waiting, and appointments once their time has come
// (or the patient has checked in early).
const isWaiting = (t, mins) => t.status === "waiting" || (t.status === "booked" && (t.slot_time <= mins || !!t.arrived_at));
// "Since when" a patient has been in line, used to put the oldest first.
function waitingSince(t) {
  if (t.type === "booked") { const d = new Date(); d.setHours(0, t.slot_time, 0, 0); return d.getTime(); }
  return new Date(t.created_at).getTime();
}

const Chevron = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M8 5l8 7-8 7" /></svg>
);

export default function Shift({ tenant, staff, locationId, setError, onSignOut, onChangeLocation }) {
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceIds, setServiceIds] = useState([]);
  const [roles, setRoles] = useState(() => loadPref(ROLES_KEY, {})); // serviceId -> "queue" | "appointments" | "both" (hybrid only)
  const [room, setRoom] = useState(() => loadPref(ROOM_KEY, ""));
  const [started, setStarted] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [calling, setCalling] = useState(false); // a call/finish request is in flight
  const [clock, setClock] = useState(() => Date.now());
  const [tab, setTab] = useState("waiting"); // phone tabs
  const [view, setView] = useState("queue"); // tablet/desktop: queue | today
  const [panel, setPanel] = useState(null); // inside "With you now": null | "away" | "route"
  const [editRoom, setEditRoom] = useState(false);
  const [note, setNote] = useState("");
  const [showAllSeen, setShowAllSeen] = useState(false);
  const date = todayIso();
  const isWide = useMedia("(min-width: 768px)");
  const prefsLoaded = useRef(false);

  useEffect(() => {
    Promise.all([api.getLocations(), api.getServices()]).then(([l, s]) => { setLocations(l.locations); setServices(s.services); }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshTickets() {
    try { const r = await api.getTickets(date); setTickets(r.tickets); } catch (err) { setError(err.message); }
  }
  useEffect(() => {
    refreshTickets();
    const id = setInterval(refreshTickets, 8000); // polling, not a live subscription
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id); }, []);

  const locServices = services.filter((s) => s.location_id === locationId);
  const locationName = locations.find((l) => l.id === locationId)?.name;

  // Start of shift: pre-tick what this person covered last time (or the only service there is).
  useEffect(() => {
    if (prefsLoaded.current || locServices.length === 0) return;
    prefsLoaded.current = true;
    const saved = loadPref(SERVICES_KEY, []);
    const valid = Array.isArray(saved) ? saved.filter((id) => locServices.some((s) => s.id === id)) : [];
    setServiceIds(valid.length ? valid : locServices.length === 1 ? [locServices[0].id] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  const nowMin = nowMinutes();
  function workTypeFor(serviceId) {
    const svc = services.find((x) => x.id === serviceId);
    if (svc?.mode === "queue") return "queue";
    if (svc?.mode === "appointment") return "appointments";
    return roles[serviceId] || "both";
  }
  // Can this person take this ticket given what they chose to cover (queue / appointments / both)?
  function coveredByRole(t) {
    const wt = workTypeFor(t.service_id);
    return t.type === "booked" ? wt !== "queue" : wt !== "appointments";
  }
  // The server insists on somewhere to send people; if no room was typed, use the location name.
  const roomLabel = room.trim() || locationName || "the front desk";

  const myTickets = tickets.filter((t) => serviceIds.includes(t.service_id));
  const inProgress = tickets.filter((t) => t.status === "serving" && locServices.some((x) => x.id === t.service_id));
  const mine = inProgress.filter((t) => t.called_by_staff_id === staff?.id);
  const busy = mine.length > 0;
  const servingKey = mine.map((t) => t.id).join(",");

  // Phone: jump to "With you" when someone is called, and back to "Waiting" after Finish.
  const prevServing = useRef("");
  useEffect(() => {
    if (servingKey && servingKey !== prevServing.current) { setTab("now"); setPanel(null); }
    else if (!servingKey && prevServing.current) { setTab("waiting"); setPanel(null); }
    prevServing.current = servingKey;
  }, [servingKey]);

  // ---------------- Start of shift ----------------
  if (!started) {
    const waitingCount = (id) => tickets.filter((t) => t.service_id === id && isWaiting(t, nowMin)).length;
    const toggle = (id, on) => setServiceIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
    const start = () => {
      savePref(ROOM_KEY, room.trim());
      savePref(SERVICES_KEY, serviceIds);
      savePref(ROLES_KEY, roles);
      setStarted(true);
    };
    return (
      <main className="narrow auth start">
        <div>
          <div className="hello">Hello {staff?.firstName}</div>
          <h1 className="h-big">Where are you working today?</h1>
          {locationName && <p className="muted loc-line">{locationName}{onChangeLocation && <> · <button type="button" className="link-btn inline" onClick={onChangeLocation}>Change location</button></>}</p>}
        </div>
        <fieldset>
          <legend className="field-label lg">{locServices.length > 1 ? "Service (tick every service you are covering)" : "Service"}</legend>
          <div className="opts">
            {locServices.map((s) => {
              const n = waitingCount(s.id);
              const on = serviceIds.includes(s.id);
              return (
                <div key={s.id}>
                  <label className="opt opt-lg">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(s.id, e.target.checked)} />
                    <span className="box" aria-hidden="true" />
                    <span className="opt-main">{s.name}<span className="opt-sub">{n === 0 ? "Nobody waiting" : `${n} waiting`}</span></span>
                  </label>
                  {on && s.mode === "hybrid" && (
                    <fieldset className="role-pick">
                      <legend className="field-hint nomargin">For {s.name} I'll look after:</legend>
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
              );
            })}
            {locServices.length === 0 && <div className="help-card">No services are set up at this location yet. Ask your manager.</div>}
          </div>
        </fieldset>
        <div>
          <label className="field-label lg" htmlFor="room-setup">Room or desk <span className="optional">(optional)</span></label>
          <input id="room-setup" className="input input-lg" placeholder="e.g. Room 2" value={room} maxLength={60} autoComplete="off" onChange={(e) => setRoom(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && serviceIds.length) start(); }} />
          <div className="field-hint">Patients are told to come here when you call them.</div>
        </div>
        <div className="start-foot">
          <button className="btn-big btn-fill" disabled={serviceIds.length === 0} aria-describedby={serviceIds.length === 0 ? "start-hint" : undefined} onClick={start}>Start</button>
          <div id="start-hint" className="field-hint center">{serviceIds.length === 0 ? "Tick at least one service to start." : "We'll remember this on this device for next time."}</div>
        </div>
        <div><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
      </main>
    );
  }

  // ---------------- Working screen ----------------
  async function doAction(fn, then) {
    try { setCalling(true); await fn(); if (then) then(); await refreshTickets(); } catch (err) { setError(err.message); await refreshTickets(); } finally { setCalling(false); }
  }
  async function callTicket(t) {
    setNote("");
    await doAction(() => api.callTicket(t.id, { roomLabel }));
  }
  function saveRoom(v) { setRoom(v); savePref(ROOM_KEY, v.trim()); }

  const waitingList = myTickets.filter((t) => isWaiting(t, nowMin) && coveredByRole(t)).sort((a, b) => waitingSince(a) - waitingSince(b));
  const seen = myTickets.filter((t) => t.status === "completed").sort((a, b) => new Date(b.finished_at || b.called_at || b.created_at) - new Date(a.finished_at || a.called_at || a.created_at));
  const waits = seen.filter((t) => t.type !== "booked" && t.called_at).map((t) => (new Date(t.called_at) - new Date(t.created_at)) / 60000);
  const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
  const multi = serviceIds.length > 1;
  const svcName = (id) => services.find((x) => x.id === id)?.name || "";
  const covered = locServices.filter((s) => serviceIds.includes(s.id));
  const next = waitingList[0];
  const canCall = !busy && !calling;
  const headLine = [covered.map((s) => s.name).join(", "), locationName].filter(Boolean).join(" · ");
  const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : tenant?.business_name;
  const signOutHint = "Finish the patient with you before signing out.";

  function patientKind(t) {
    return t.type === "booked" ? `Appointment ${formatTime(t.slot_time)}` : "Walk-in";
  }

  const stepHead = (n, title, hint, tone, id) => (
    <div className="step-head">
      <span className={`step-num ${tone}`} aria-hidden="true">{n}</span>
      <div>
        <h2 className="step-title" id={id}>{title}</h2>
        <p className="step-hint">{hint}</p>
      </div>
    </div>
  );

  const waitingCol = (
    <section className="step" aria-labelledby="step-waiting">
      {stepHead(1, "Waiting", "Tap Call on the highlighted patient", "navy", "step-waiting")}
      {waitingList.length === 0 && <div className="empty-card">Nobody is waiting right now.</div>}
      <div className="cards" role="list">
        {waitingList.map((t, i) => {
          const first = i === 0;
          const wm = t.type === "booked" ? null : minutesSince(t.created_at, clock);
          return (
            <div key={t.id} role="listitem" className={`pcard${first ? " pcard-next" : ""}`}>
              <div className="pcard-top">
                <span className="tn mono">{t.ticket_number}</span>
                {t.type === "booked" && <span className="badge badge-blue">Appointment</span>}
                {first && <span className="badge badge-next">Next</span>}
              </div>
              <div className="pcard-info">
                {t.type === "booked"
                  ? <>Booked {formatTime(t.slot_time)}{t.arrived_at ? ` · checked in ${formatClock(t.arrived_at)}` : ""}</>
                  : <>Waiting {wm} min</>}
                {multi && <> · {svcName(t.service_id)}</>}
              </div>
              {first ? (
                <>
                  <button className="btn-big btn-fill call-btn" disabled={!canCall} aria-describedby={busy ? "call-note" : undefined} onClick={() => callTicket(t)}>Call this patient</button>
                  {busy && <div id="call-note" className="field-hint nomargin">Finish the patient with you first.</div>}
                </>
              ) : (
                <button className="btn-sec call-small" disabled={!canCall} aria-label={`Call ${t.ticket_number}`} onClick={() => callTicket(t)}>Call</button>
              )}
            </div>
          );
        })}
      </div>
      <div><button className="link-btn" onClick={refreshTickets}>Refresh the list</button></div>
    </section>
  );

  const nowCol = (
    <section className="step" aria-labelledby="step-now">
      {stepHead(2, "With you now", "Tap Finish when they leave", "amber", "step-now")}
      {mine.length === 0 && (
        <div className="empty-card calm">
          <strong>Nobody with you.</strong>
          <span>{isWide ? "Tap Call this patient on the left." : "Go to 1 Waiting and tap Call this patient."}</span>
        </div>
      )}
      {mine.map((t) => {
        const others = locServices.filter((x) => x.id !== t.service_id);
        return (
          <div key={t.id} className="scard">
            <div className="scard-num mono">{t.ticket_number}</div>
            <div>
              <div className="scard-svc">{svcName(t.service_id)}{t.type === "booked" ? ` · Appointment ${formatTime(t.slot_time)}` : ""}</div>
              <div className="scard-time">With you for <span className="mono">{t.called_at ? formatElapsed(clock - new Date(t.called_at).getTime()) : "0:00"}</span>{t.called_room ? ` · ${t.called_room}` : ""}</div>
            </div>
            <button className="btn-big btn-finish" disabled={calling} onClick={() => doAction(() => api.closeTicket(t.id))}>Finish this patient</button>
            {panel === null && (
              <>
                <button className="btn-sec" disabled={calling} onClick={async () => { try { await api.callAgain(t.id, { roomLabel }); setNote(`Called ${t.ticket_number} again.`); } catch (err) { setError(err.message); } }}>Call again</button>
                <button className="btn-sec" disabled={calling} aria-haspopup="true" onClick={() => setPanel("away")}>Didn't arrive</button>
                {others.length > 0 && <button className="btn-sec" disabled={calling} aria-haspopup="true" onClick={() => setPanel("route")}>Send to another service</button>}
              </>
            )}
            {panel === "away" && (
              <div className="sub-panel" role="group" aria-label="They didn't arrive">
                <div className="sub-title">What should happen to {t.ticket_number}?</div>
                <button className="btn-sec" disabled={calling} onClick={() => doAction(() => api.returnToQueue(t.id, { clockMinutes: nowMinutes() }), () => setPanel(null))}>Put them back in the queue</button>
                <button className="btn-sec btn-warn" disabled={calling} onClick={() => doAction(() => api.noShowTicket(t.id), () => setPanel(null))}>They left: mark as no-show</button>
                <button className="btn-sec btn-warn" disabled={calling} onClick={() => doAction(() => api.cancelTicket(t.id), () => setPanel(null))}>Cancel this ticket</button>
                <button className="link-btn" onClick={() => setPanel(null)}>Go back</button>
              </div>
            )}
            {panel === "route" && (
              <div className="sub-panel" role="group" aria-label="Send to another service">
                <div className="sub-title">Send {t.ticket_number} to:</div>
                {others.map((x) => (
                  <button key={x.id} className="btn-sec" disabled={calling} onClick={() => doAction(() => api.routeTicket(t.id, { newServiceId: x.id, clockMinutes: nowMinutes() }), () => setPanel(null))}>{x.name}</button>
                ))}
                <button className="link-btn" onClick={() => setPanel(null)}>Go back</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="sr-only" role="status" aria-live="polite">{note}</div>
      {note && <div className="field-ok" aria-hidden="true">{note}</div>}
    </section>
  );

  const shownSeen = showAllSeen ? seen : seen.slice(0, 8);
  const seenCol = (
    <section className="step" aria-labelledby="step-seen">
      {stepHead(3, "Seen today", seen.length === 0 ? "Nobody seen yet today" : `${seen.length} ${seen.length === 1 ? "patient" : "patients"}${avgWait != null ? ` · average wait ${avgWait} min` : ""}`, "navy", "step-seen")}
      {seen.length === 0 ? <div className="empty-card">Patients you finish will appear here.</div> : (
        <div className="seen-list" role="list">
          {shownSeen.map((t) => (
            <div key={t.id} role="listitem" className="seen-row">
              <span className="mono tn-s">{t.ticket_number}</span>
              <span className="seen-name">{multi ? svcName(t.service_id) : t.type === "booked" ? "Appointment" : "Walk-in"}{t.closed_by_system ? " · closed by system" : ""}</span>
              <span className="seen-time">{t.finished_at ? formatClock(t.finished_at) : "—"}</span>
            </div>
          ))}
        </div>
      )}
      {seen.length > 8 && <div><button className="link-btn" onClick={() => setShowAllSeen((v) => !v)}>{showAllSeen ? "Show fewer" : `Show all ${seen.length}`}</button></div>}
    </section>
  );

  const tabs = [
    ["waiting", "1 Waiting", String(waitingList.length)],
    ["now", "2 With you", mine[0]?.ticket_number || "none"],
    ["seen", "3 Seen", String(seen.length)],
  ];
  const wideToday = isWide && view === "today";

  return (
    <>
      <div className="kiosk-bar">
        <button type="button" className="who" aria-label={`${staffName}${room.trim() ? `, ${room.trim()}` : ""}. Change room or desk`} aria-expanded={editRoom} onClick={() => setEditRoom((v) => !v)}>
          <span className="who-top">{headLine || tenant?.business_name}</span>
          <span className="who-sub">{staffName}{room.trim() ? ` · ${room.trim()}` : ""}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg></span>
        </button>
        {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {date}</span>}
        <button className="btn-signout" disabled={busy} aria-describedby={busy ? "signout-hint" : undefined} title={busy ? signOutHint : undefined} onClick={onSignOut}>Sign out</button>
        {busy && <span id="signout-hint" className="sr-only">{signOutHint}</span>}
      </div>
      {editRoom && (
        <form className="room-edit" onSubmit={(e) => { e.preventDefault(); setEditRoom(false); }}>
          <label className="field-label" htmlFor="room-edit">Room or desk <span className="optional">(optional)</span></label>
          <div className="room-edit-row">
            <input id="room-edit" className="input" placeholder="e.g. Room 2" value={room} maxLength={60} autoFocus autoComplete="off" onChange={(e) => saveRoom(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditRoom(false); }} />
            <button type="submit" className="btn-sec">Done</button>
          </div>
        </form>
      )}
      {busy && <div className="sr-only" id="busy-note">{signOutHint}</div>}

      <main className="work">
        {isWide && (
          <div className="view-toggle" role="tablist" aria-label="Choose a view">
            {[["queue", "Queue"], ["today", "Today"]].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={`vt${view === k ? " on" : ""}`} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>
        )}

        {wideToday && <div className="today-wrap"><TodayPanel embedded services={covered.map((x) => ({ id: x.id, name: x.name }))} /></div>}

        {isWide && !wideToday && (
          <div className="board">
            {waitingCol}
            <div className="arrow" aria-hidden="true"><Chevron /></div>
            {nowCol}
            <div className="arrow" aria-hidden="true"><Chevron /></div>
            {seenCol}
          </div>
        )}

        {!isWide && (
          <div className="phone">
            <div className="tabs" role="tablist" aria-label="Steps">
              {tabs.map(([k, label, sub]) => (
                <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
                  <span>{label}</span><span className="mono tab-sub">{sub}</span>
                </button>
              ))}
            </div>
            {tab !== "waiting" && next && (
              <div className="next-hint"><span>Next patient:{" "}<strong className="mono">{next.ticket_number}</strong>{" "}{next.type === "booked" ? `(${patientKind(next)}) ` : ""}(tap 1 to call)</span></div>
            )}
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === "waiting" && waitingCol}
              {tab === "now" && nowCol}
              {tab === "seen" && seenCol}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
