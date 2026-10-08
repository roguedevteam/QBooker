import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "./lib/api.js";
import { alertPref } from "./lib/storage.js";
import { nowMinutes } from "./lib/clock.js";
import Shell, { Bubble, POWERED_BY } from "./Shell.jsx";

const POLL_MS = 10000;

// The WhatsApp business number isn't connected yet. Set VITE_WHATSAPP_NUMBER (digits only, with
// country code, e.g. 447700900123) once it exists; until then the button only records the request.
const WA_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER || "").replace(/\D/g, "");
const waHref = (text) => (WA_NUMBER ? `https://wa.me/${WA_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ""}` : null);

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

export default function Returning({ token, onSeen, onEnded, onRestart }) {
  const [data, setData] = useState(null);          // last good response
  const [problem, setProblem] = useState(null);    // "unknown" | "offline" | null
  const [lastOk, setLastOk] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [alertOn, setAlertOn] = useState(() => alertPref.get());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const [waBusy, setWaBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [waNoted, setWaNoted] = useState(false);
  const audioRef = useRef(null);
  const prevState = useRef(null);
  const endedReported = useRef(false);
  const notFoundRef = useRef(false); // the server said this ticket doesn't exist: nothing to wait for, stop asking

  async function checkIn() {
    setCheckBusy(true); setCheckError("");
    try { await api.checkInPublic(token); setCheckedIn(true); poll(); }
    catch (err) { setCheckError(err.message || "We couldn't check you in. Please tell reception you're here."); }
    finally { setCheckBusy(false); }
  }
  const poll = useCallback(async () => {
    if (notFoundRef.current) return;
    try {
      const r = await api.getPublicTicket(token);
      setData(r); setProblem(null); setLastOk(Date.now());
      onSeen?.();
      if (r.state !== "waiting" && r.state !== "called" && !endedReported.current) { endedReported.current = true; onEnded?.(r.state); }
    } catch (err) {
      if (err.status === 404) { notFoundRef.current = true; setProblem("unknown"); setData(null); if (!endedReported.current) { endedReported.current = true; onEnded?.("unknown"); } }
      else setProblem("offline"); // keep showing the last good data and keep retrying
    }
  }, [token, onSeen, onEnded]);

  // Poll every ~10s, but only while the tab is visible; catch up straight away on return.
  useEffect(() => {
    let timer = null;
    const tick = () => { if (notFoundRef.current) { clearInterval(timer); return; } if (!document.hidden) poll(); };
    const start = () => { clearInterval(timer); timer = setInterval(tick, POLL_MS); };
    const onVis = () => { if (notFoundRef.current) return; if (!document.hidden) { poll(); start(); } else clearInterval(timer); };
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

  function wantWhatsApp() {
    // Open WhatsApp first (inside the tap, so popup blockers allow it), then record the request.
    const href = waHref(`Ticket ${data?.ticketNumber || ""}`.trim());
    if (href) window.open(href, "_blank", "noopener,noreferrer");
    setWaBusy(true);
    api.whatsappIntent(token)
      .then(() => { setWaNoted(true); setData((d) => ({ ...d, whatsappUpdatesRequested: true })); })
      .catch(() => { /* non-critical */ })
      .finally(() => setWaBusy(false));
  }

  const ago = lastOk ? Math.max(0, Math.round((now - lastOk) / 1000)) : null;
  const agoText = ago == null ? "" : ago < 8 ? "updated just now" : ago < 60 ? `updated ${ago}s ago` : `updated ${Math.round(ago / 60)} min ago`;
  const live = !problem && !!lastOk;
  const title = data?.businessName || "QBooker";
  const frame = (subtitle, footer, children, listProps) => (
    <Shell title={title} subtitle={subtitle} footer={footer} top listProps={listProps}>{children}</Shell>
  );
  const startAgainBtn = (
    <div className="choices"><button type="button" className="choice choice-primary" onClick={onRestart}><span className="choice-label">Start again</span></button></div>
  );

  // ---- Unknown / not loaded yet
  if (problem === "unknown") {
    return frame("Ticket not found", POWERED_BY, <>
      <Bubble>We can't find your ticket. Scan the QR code at reception again.</Bubble>
      {startAgainBtn}
    </>, { role: "alert" });
  }
  if (!data) {
    return frame("Finding your ticket", POWERED_BY, <>
      <Bubble>{problem === "offline" ? "We can't reach the clinic right now. Trying again…" : "Finding your ticket…"}</Bubble>
      {problem === "offline" && <div className="choices"><button type="button" className="choice choice-secondary" onClick={poll}><span className="choice-label">Try again</span></button></div>}
    </>, { role: "status" });
  }

  // ---- Ended states
  if (state === "cancelled" || state === "closed" || state === "expired") {
    const copy = {
      cancelled: ["You've left the queue", "Your place has been released. Come back any time if you change your mind."],
      closed: ["Your visit is finished", "This ticket has ended. Thank you for waiting."],
      expired: ["This ticket has expired", "It was for an earlier day. Scan the QR code at reception to join again."],
    }[state];
    return frame(copy[0], POWERED_BY, <>
      <Bubble><strong>{copy[0]}.</strong> {copy[1]}</Bubble>
      {startAgainBtn}
    </>, { role: "status" });
  }

  const called = state === "called";
  const booked = data.type === "booked";
  const ahead = data.peopleAhead;
  const mins = data.estimatedMinutes;
  const minsToGo = booked && typeof data.slotTime === "number" ? data.slotTime - nowMinutes() : null;
  const soon = minsToGo != null && minsToGo > 0 && minsToGo <= 15;
  const subtitle = called ? "It's your turn" : booked ? "Your appointment" : "You're in the queue";
  const waNotedNow = data.whatsappUpdatesRequested || waNoted;

  const card = called ? (
    <section className="ticket ticket-called" role="alert" aria-live="assertive" aria-label={`Ticket ${data.ticketNumber}`}>
      <div className="ticket-body">
        <div className="ticket-sub">Your ticket · {data.serviceName}</div>
        <div className="ticket-called-num mono">{data.ticketNumber}</div>
        <h2 className="called-title">{data.calledRoom ? <>Please go to <span className="called-room">{data.calledRoom}</span></> : "Please go to the desk"}</h2>
        <p className="ticket-text">{data.calledRoom ? "Please make your way there now." : "Please make your way there now, or ask a member of staff."}</p>
      </div>
    </section>
  ) : (
    <section className="ticket" aria-live="polite" aria-label={`Ticket ${data.ticketNumber}`}>
      <div className="ticket-band">
        <span className="ticket-band-label">Your ticket · {data.serviceName}</span>
        <span className="ticket-band-num mono">{data.ticketNumber}</span>
      </div>
      <div className="ticket-body">
        {booked ? (
          <div className="ticket-pos"><span className="pos-num mono">{typeof data.slotTime === "number" ? formatTime(data.slotTime) : "Today"}</span>{typeof data.slotTime === "number" && <span className="pos-label">today</span>}</div>
        ) : ahead == null ? (
          <div className="pos-label">You're in the queue</div>
        ) : (
          <div className="ticket-pos"><span className="pos-num mono">{ahead + 1}</span><span className="pos-label">in line</span></div>
        )}
        <p className="ticket-text">
          {booked
            ? "Please arrive a few minutes early and take a seat. "
            : mins != null && ahead != null ? (ahead === 0 || mins < 1 ? "You're next. " : `About ${mins} minutes. `) : ""}
          {!booked && "Take a seat. "}
          This updates by itself, and your number shows here when it's your turn.
        </p>
        <div className={`live-line${live ? "" : " is-off"}`} role="status">
          <span className="live-dot" aria-hidden="true" />
          {live ? `Live · ${agoText}` : problem === "offline" ? `Reconnecting · ${agoText || "last update unavailable"}` : "Connecting…"}
        </div>
      </div>
    </section>
  );

  return frame(subtitle, called ? POWERED_BY : "Saved on this phone. Come back to this page any time to see your place.", <>
    {card}

    {!called && booked && (data.arrived || checkedIn ? (
      <Bubble><strong>You're checked in.</strong> The clinic knows you're here. Take a seat.</Bubble>
    ) : (
      <>
        <Bubble>Here already? Let the clinic know you've arrived.</Bubble>
        {checkError && <div className="ret-error" role="alert">{checkError}</div>}
        <div className="choices"><button type="button" className="choice choice-primary" disabled={checkBusy} onClick={checkIn}><span className="choice-label">{checkBusy ? "Checking in…" : "I've arrived"}</span></button></div>
      </>
    ))}

    {!called && soon && <Bubble>Your appointment is in {minsToGo} minute{minsToGo === 1 ? "" : "s"}.</Bubble>}

    {!called && (waNotedNow ? (
      <Bubble><strong>Noted.</strong> You asked for WhatsApp updates, but they aren't switched on yet. Please keep this page open to see when you're called.</Bubble>
    ) : (
      <>
        <Bubble>Want a message when you're nearly up? Then you can put your phone away.</Bubble>
        <div className="choices"><button type="button" className="choice choice-secondary" disabled={waBusy} onClick={wantWhatsApp}><span className="choice-label">Get updates on WhatsApp</span></button></div>
      </>
    ))}

    <div className="ret-switch">
      <span id="alert-label" className="ret-switch-label">Sound and vibrate when I'm called</span>
      <button type="button" role="switch" aria-checked={alertOn} aria-labelledby="alert-label" className={`switch${alertOn ? " is-on" : ""}`} onClick={toggleAlert}><span className="switch-knob" /></button>
    </div>
    {alertOn && <div className="ret-fine">Keep this page open. Some phones won't sound or vibrate while the screen is off.</div>}

    {problem === "offline" && <div className="ret-offline" role="status">Can't refresh right now. Showing the last update. We'll keep trying.</div>}

    {!called && (confirmLeave ? (
      <div className="leave-confirm" role="alertdialog" aria-labelledby="leave-q">
        <Bubble><span id="leave-q"><strong>{booked ? "Cancel your appointment?" : "Leave the queue?"}</strong> {booked ? "You'll lose your slot." : "You'll lose your place."}</span></Bubble>
        {leaveError && <div className="ret-error" role="alert">{leaveError}</div>}
        <div className="choices">
          <button type="button" className="choice choice-danger" disabled={leaving} onClick={leave}><span className="choice-label">{leaving ? "Leaving…" : "Yes, leave"}</span></button>
          <button type="button" className="choice choice-secondary" disabled={leaving} onClick={() => { setConfirmLeave(false); setLeaveError(""); }}><span className="choice-label">Keep my place</span></button>
        </div>
      </div>
    ) : (
      <button type="button" className="leave-link" onClick={() => setConfirmLeave(true)}>{booked ? "Cancel my appointment" : "Leave the queue"}</button>
    ))}

    <p className="ret-fine">Lost this page? Scan the QR code at reception again on this phone and we'll find your ticket.</p>
  </>);
}
