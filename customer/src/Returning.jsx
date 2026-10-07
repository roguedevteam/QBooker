import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "./lib/api.js";
import { alertPref } from "./lib/storage.js";

const POLL_MS = 10000;

function formatTime(min) {
  let h = Math.floor(min / 60); const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am"; h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

// Short beep via Web Audio. Needs a user gesture the first time, which is why the context is
// created when the person switches the toggle on.
function beep(ctx) {
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    [0, 0.35].forEach((offset) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + offset); osc.stop(now + offset + 0.3);
    });
  } catch { /* ignore */ }
}
function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ } }

export default function Returning({ token, justJoined, onSeen, onEnded, onRestart }) {
  const [data, setData] = useState(null);          // last good response
  const [problem, setProblem] = useState(null);    // "unknown" | "offline" | null
  const [lastOk, setLastOk] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [maxAhead, setMaxAhead] = useState(0);
  const [alertOn, setAlertOn] = useState(() => alertPref.get());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const [waBusy, setWaBusy] = useState(false);
  const [waNoted, setWaNoted] = useState(false);
  const audioRef = useRef(null);
  const prevState = useRef(null);
  const endedReported = useRef(false);

  const poll = useCallback(async () => {
    try {
      const r = await api.getPublicTicket(token);
      setData(r); setProblem(null); setLastOk(Date.now());
      if (r.peopleAhead != null) setMaxAhead((m) => Math.max(m, r.peopleAhead));
      onSeen?.();
      if (r.state !== "waiting" && r.state !== "called" && !endedReported.current) { endedReported.current = true; onEnded?.(r.state); }
    } catch (err) {
      if (err.status === 404) { setProblem("unknown"); setData(null); if (!endedReported.current) { endedReported.current = true; onEnded?.("unknown"); } }
      else setProblem("offline"); // keep showing the last good data and keep retrying
    }
  }, [token, onSeen, onEnded]);

  // Poll every ~10s, but only while the tab is visible; catch up straight away on return.
  useEffect(() => {
    let timer = null;
    const tick = () => { if (!document.hidden) poll(); };
    const start = () => { clearInterval(timer); timer = setInterval(tick, POLL_MS); };
    const onVis = () => { if (!document.hidden) { poll(); start(); } else clearInterval(timer); };
    poll(); start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [poll]);

  // Keeps "updated 12s ago" honest.
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(i); }, []);

  const state = data?.state;

  // Called: sound + vibration (if switched on) and a document title that shows in the tab strip.
  useEffect(() => {
    const original = document.title;
    if (state === "called") document.title = "You're being called · " + (data?.ticketNumber || "");
    else if (state === "waiting" && data?.peopleAhead != null) document.title = `${data.ticketNumber} · ${data.peopleAhead === 0 ? "you're next" : `${data.peopleAhead} ahead`}`;
    return () => { document.title = original; };
  }, [state, data?.ticketNumber, data?.peopleAhead]);

  useEffect(() => {
    if (state === "called" && prevState.current && prevState.current !== "called" && alertOn) {
      beep(audioRef.current); vibrate([400, 200, 400, 200, 400]);
    }
    if (state) prevState.current = state;
  }, [state, alertOn]);

  function toggleAlert() {
    const next = !alertOn;
    setAlertOn(next); alertPref.set(next);
    if (next) {
      try {
        if (!audioRef.current) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioRef.current = new AC(); }
        audioRef.current?.resume?.();
      } catch { /* ignore */ }
      beep(audioRef.current); vibrate(120); // a quick preview so they know it works
    }
  }
  // If the preference was saved on a previous visit, the audio context still needs a gesture.
  useEffect(() => {
    if (!alertOn) return;
    const arm = () => {
      try { if (!audioRef.current) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioRef.current = new AC(); } audioRef.current?.resume?.(); } catch { /* ignore */ }
    };
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, [alertOn]);

  async function leave() {
    setLeaving(true); setLeaveError("");
    try {
      await api.leavePublicTicket(token);
      setConfirmLeave(false);
      setData((d) => ({ ...(d || {}), state: "cancelled" }));
      endedReported.current = true; onEnded?.("cancelled");
    } catch (err) {
      setLeaveError(err.network ? "We couldn't reach the clinic. Check your connection and try again." : err.message);
    } finally { setLeaving(false); }
  }

  async function wantWhatsApp() {
    setWaBusy(true);
    try { await api.whatsappIntent(token); setWaNoted(true); setData((d) => ({ ...d, whatsappUpdatesRequested: true })); }
    catch { /* non-critical */ }
    finally { setWaBusy(false); }
  }

  const ago = lastOk ? Math.max(0, Math.round((now - lastOk) / 1000)) : null;
  const agoText = ago == null ? "" : ago < 8 ? "updated just now" : ago < 60 ? `updated ${ago}s ago` : `updated ${Math.round(ago / 60)} min ago`;
  const live = !problem && !!lastOk;

  const header = (
    <header className="ret-head">
      <div className="ret-head-title">{data?.businessName || "QBooker"}</div>
      {data && (state === "waiting" || state === "called") && (
        <span className={`live${live ? "" : " is-off"}`} role="status"><span className="live-dot" aria-hidden="true" />{live ? "Live" : "Reconnecting"}</span>
      )}
    </header>
  );

  // ---- Unknown / not loaded yet
  if (problem === "unknown") {
    return (
      <div className="ret">{header}
        <main className="ret-main">
          <section className="ret-card ret-end" role="alert">
            <h1 className="ret-end-title">We can't find your ticket</h1>
            <p>We can't find your ticket. Scan the QR code at reception again.</p>
            <button type="button" className="gate-btn gate-btn-fill" onClick={onRestart}>Start again</button>
          </section>
        </main>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="ret">{header}
        <main className="ret-main">
          <p className="muted" role="status">{problem === "offline" ? "We can't reach the clinic right now. Trying again…" : "Finding your ticket…"}</p>
          {problem === "offline" && <button type="button" className="btn-outline" onClick={poll}>Try again</button>}
        </main>
      </div>
    );
  }

  // ---- Ended states
  if (state === "cancelled" || state === "closed" || state === "expired") {
    const copy = {
      cancelled: ["You've left the queue", "Your place has been released. Come back any time if you change your mind."],
      closed: ["Your visit is finished", "This ticket has ended. Thank you for waiting."],
      expired: ["This ticket has expired", "It was for an earlier day. Scan the QR code at reception to join again."],
    }[state];
    return (
      <div className="ret">{header}
        <main className="ret-main">
          <section className="ret-card ret-end" role="status">
            <div className="ret-sub">{data.serviceName} · {data.ticketNumber}</div>
            <h1 className="ret-end-title">{copy[0]}</h1>
            <p>{copy[1]}</p>
            <button type="button" className="gate-btn gate-btn-fill" onClick={onRestart}>Start again</button>
          </section>
        </main>
      </div>
    );
  }

  const called = state === "called";
  const ahead = data.peopleAhead;
  const done = Math.max(0, maxAhead - (ahead ?? 0));
  const segs = [];
  for (let i = 0; i < Math.min(maxAhead, 7); i++) segs.push(i < (maxAhead > 7 ? Math.round((done / maxAhead) * 7) : done) ? "done" : "ahead");
  segs.push("you");

  return (
    <div className="ret">{header}
      <main className="ret-main">
        <div className="ret-sub">{justJoined ? "We saved your place on this phone." : "Welcome back. We saved your place on this phone."}</div>

        {called ? (
          <section className="ret-card ret-called" role="alert" aria-live="assertive">
            <div className="ret-sub">Your ticket · {data.serviceName}</div>
            <div className="ret-num mono">{data.ticketNumber}</div>
            <h1 className="ret-called-title">You're being called.</h1>
            <p className="ret-called-room">{data.calledRoom ? <>Go to <strong>{data.calledRoom}</strong></> : "Please go to the desk, or ask a member of staff."}</p>
          </section>
        ) : (
          <section className="ret-card" aria-live="polite">
            <div className="ret-sub">Your ticket · {data.serviceName}</div>
            <div className="ret-num mono">{data.ticketNumber}</div>
            {data.type === "booked" ? (
              <div className="ret-ahead">Booked for {typeof data.slotTime === "number" ? formatTime(data.slotTime) : "today"}</div>
            ) : (
              <div className="ret-ahead">{ahead == null ? "You're in the queue" : ahead === 0 ? "You're next" : `${ahead} ${ahead === 1 ? "person" : "people"} ahead of you`}</div>
            )}
            <div className="ret-meta">
              {data.estimatedMinutes != null && data.type !== "booked" ? `About ${data.estimatedMinutes} minutes` : data.locationName}
              {agoText && ` · ${agoText}`}
            </div>
            {data.type !== "booked" && ahead != null && (
              <>
                <div className="segs" role="progressbar" aria-label="Progress to your turn" aria-valuemin={0} aria-valuemax={maxAhead || 1} aria-valuenow={done}>
                  {segs.map((k, i) => <span key={i} className={`seg seg-${k}`} />)}
                </div>
                <div className="ret-legend">{done > 0 ? `${done} seen · ` : ""}{ahead} ahead · You</div>
              </>
            )}
          </section>
        )}

        {!called && data.whatsappUpdatesOffer && (
          data.whatsappUpdatesRequested || waNoted ? (
            <div className="ret-wa" role="status">
              <strong>Noted.</strong> You asked for WhatsApp updates, but they aren't switched on yet. Please keep this page open to see when you're called.
            </div>
          ) : (
            <div className="ret-wa">
              <div><strong>Want to leave the page?</strong> We'll message you on WhatsApp when you're nearly up.</div>
              <button type="button" className="gate-btn gate-btn-fill gate-btn-sm" disabled={waBusy} onClick={wantWhatsApp}>Message me on WhatsApp</button>
            </div>
          )
        )}

        <div className="ret-switch">
          <span id="alert-label" className="ret-switch-label">Sound and vibrate when I'm called</span>
          <button type="button" role="switch" aria-checked={alertOn} aria-labelledby="alert-label" className={`switch${alertOn ? " is-on" : ""}`} onClick={toggleAlert}><span className="switch-knob" /></button>
        </div>
        {alertOn && <div className="ret-fine">Keep this page open. Some phones won't sound or vibrate while the screen is off.</div>}

        {problem === "offline" && <div className="ret-offline" role="status">Can't refresh right now. Showing the last update. We'll keep trying.</div>}

        {!called && (confirmLeave ? (
          <div className="ret-confirm" role="alertdialog" aria-labelledby="leave-q">
            <div id="leave-q"><strong>Leave the queue?</strong> You'll lose your place.</div>
            {leaveError && <div className="ret-error" role="alert">{leaveError}</div>}
            <div className="ret-confirm-btns">
              <button type="button" className="gate-btn gate-btn-danger-fill gate-btn-sm" disabled={leaving} onClick={leave}>{leaving ? "Leaving…" : "Yes, leave"}</button>
              <button type="button" className="gate-btn gate-btn-outline gate-btn-sm" disabled={leaving} onClick={() => { setConfirmLeave(false); setLeaveError(""); }}>Keep my place</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ret-leave" onClick={() => setConfirmLeave(true)}>Leave the queue</button>
        ))}

        <div className="ret-fine">Lost this page? Scan the QR code at reception again on this phone and we'll find your ticket.</div>
      </main>
    </div>
  );
}
