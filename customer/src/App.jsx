import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { api } from "./lib/api.js";
import { todayIso, refreshClock } from "./lib/clock.js";

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
  const [tenantId, setTenantId] = useState(() => new URLSearchParams(window.location.search).get("t") || "");
  const [manualEntry, setManualEntry] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="screen-msg muted" role="status">Loading…</div>;

  if (!tenantId) {
    return (
      <form className="narrow card stack entry" onSubmit={(e) => { e.preventDefault(); if (manualEntry.trim()) setTenantId(manualEntry.trim()); }}>
        <h1 className="entry-title">QBooker</h1>
        <p className="muted entry-copy">
          This page needs a business link to know who you're booking with — normally you'd arrive here
          via a link shared by the business. For testing, paste the business ID shown in their Admin portal.
        </p>
        <label className="sr-only" htmlFor="biz-id">Business ID</label>
        <input id="biz-id" className="input" placeholder="Business ID" autoComplete="off" value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} />
        <button className="btn btn-accent" type="submit" disabled={!manualEntry.trim()}>Continue</button>
      </form>
    );
  }

  return <CustomerWhatsApp tenantId={tenantId} />;
}

function CustomerWhatsApp({ tenantId }) {
  const [error, setError] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState([]);
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [options, setOptions] = useState([]);
  const [watchedTicket, setWatchedTicket] = useState(null); // { id, ticketNumber, type, slotTime }
  const [ticketStatus, setTicketStatus] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null); // { position, estimatedMinutes } — walk-ins only
  const [cancelling, setCancelling] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [serviceName, setServiceName] = useState(""); // header subtitle only (display)
  const [pickedIdx, setPickedIdx] = useState(null); // visual "selected" state for the tapped option
  const scrollRef = useRef(null);
  const lastStatusRef = useRef(null);
  const reminderSentRef = useRef(false);

  useEffect(() => {
    Promise.all([api.getInfo(tenantId), api.getLocations(tenantId), api.getServices(tenantId)])
      .then(([info, l, s]) => {
        setBusinessName(info.businessName);
        setLocations(l.locations);
        setServices(s.services);
        setMessages([{ from: "bot", text: `Welcome to ${info.businessName} 👋 Reply Hi to get a ticket or book a slot.` }]);
        setOptions([{ label: "Hi", action: "greet" }]);
      })
      .catch(() => setNotFound(true));
  }, [tenantId]);

  // Polls for "it's your turn" — the staff kiosk and this app are fully separate apps with
  // no other shared channel, so this is how a customer actually finds out they've been called.
  // Also keeps the live queue position (walk-ins) fresh and fires a one-off reminder as a
  // booked slot approaches — again, there's no other channel to push either of those through.
  useEffect(() => {
    if (!watchedTicket) return;
    reminderSentRef.current = false;
    setArrived(false);
    const id = setInterval(async () => {
      try {
        const r = await api.getTicketStatus(tenantId, watchedTicket.id);
        setTicketStatus(r.status);
        setQueueInfo(r.queue || null);
        setArrived(!!r.arrived);
        if ((r.status === "serving" || r.status === "completed") && lastStatusRef.current !== "serving" && lastStatusRef.current !== "completed") {
          bot(`📍 ${r.message || "It's your turn! Please head to the desk."}`, [{ label: "Simulate a new customer", action: "restart" }]);
        }
        lastStatusRef.current = r.status;
      } catch {
        // ignore transient errors, try again next tick
      }
      if (watchedTicket.type === "booked" && typeof watchedTicket.slotTime === "number" && !reminderSentRef.current) {
        const mins = nowMinutes();
        const minsToGo = watchedTicket.slotTime - mins;
        if (minsToGo > 0 && minsToGo <= 15) {
          reminderSentRef.current = true;
          bot(`⏰ Reminder: your appointment is in ${minsToGo} minute${minsToGo === 1 ? "" : "s"}.`, [{ label: "Simulate a new customer", action: "restart" }]);
        }
      }
    }, 6000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedTicket, tenantId]);

  useEffect(() => { setPickedIdx(null); }, [options]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, options]);

  async function checkInNow() {
    if (!watchedTicket) return;
    setCheckingIn(true);
    try {
      await api.checkIn(tenantId, watchedTicket.id);
      setArrived(true);
      bot("✅ You're checked in. Please take a seat — we'll call you at your appointment time, or sooner if we can.", [{ label: "Simulate a new customer", action: "restart" }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingIn(false);
    }
  }

  async function cancelMyTicket() {
    if (!watchedTicket) return;
    setCancelling(true);
    try {
      await api.cancelTicket(tenantId, watchedTicket.id);
      bot(`Your ${watchedTicket.type === "booked" ? "booking" : "spot in the queue"} has been cancelled — come back any time.`, [{ label: "Simulate a new customer", action: "restart" }]);
      lastStatusRef.current = "cancelled";
      setWatchedTicket(null);
      setTicketStatus(null);
      setQueueInfo(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  }

  function bot(text, opts, ticket) { setMessages((m) => [...m, { from: "bot", text, ticket }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text }]); }

  async function handle(action, payload) {
    if (action === "greet") {
      setServiceName("");
      user("Hi");
      if (locations.length > 1) {
        const checks = await Promise.all(locations.map(async (l) => {
          const locServices = services.filter((s) => s.location_id === l.id);
          if (locServices.length === 0) return { location: l, open: false };
          const results = await Promise.all(locServices.map((s) =>
            api.getAvailability(tenantId, s.id, todayIso(), nowMinutes()).catch(() => ({ open: false }))
          ));
          return { location: l, open: results.some((r) => r.open) };
        }));
        // Every location shows up, even ones with nothing to join right now — but only the
        // ones with something open right now are actually clickable.
        bot("Which location?", checks.map(({ location, open }) => ({
          label: open ? `${location.name} — open now` : `${location.name} — not available`,
          action: open ? "loc" : null,
          payload: location.id,
          disabled: !open,
        })));
      } else {
        await showServices(locations[0]?.id);
      }
    } else if (action === "loc") {
      user(locations.find((l) => l.id === payload)?.name);
      await showServices(payload);
    } else if (action === "svc") {
      const svc = services.find((s) => s.id === payload);
      setServiceName(svc.name);
      user(svc.name);
      try {
        const r = await api.getAvailability(tenantId, svc.id, todayIso(), nowMinutes());
        if (!r.open) {
          bot(r.reason === "outside_license_window" ? "We're not taking bookings today." : `${svc.name} isn't available right now.`, [{ label: "Choose another service", action: "greet" }]);
          return;
        }
        const opts = [];
        if (r.walkIn?.available) opts.push({ label: "Join the queue now", action: "join", payload: svc.id });
        const slots = r.bookableSlots || [];
        // Walk-ins join now; planners see a 2-hour window starting 2 hours from now. Other times are one tap away.
        const winStart = nowMinutes() + 120;
        let shown = slots.filter((t) => t >= winStart && t < winStart + 120);
        if (shown.length === 0) shown = slots.filter((t) => t >= winStart).slice(0, 3);
        if (shown.length === 0 && !r.walkIn?.available) shown = slots.slice(0, 3);
        const maxShown = r.walkIn?.available ? 7 : 8;
        shown = shown.slice(0, maxShown);
        shown.forEach((t) => opts.push({ label: `Book ${formatTime(t)} today`, action: "book", payload: { serviceId: svc.id, slotTime: t } }));
        const rest = slots.filter((t) => !shown.includes(t));
        if (rest.length > 0) opts.push({ label: "Choose another time", action: "times", payload: { serviceId: svc.id, slots: rest } });
        if (opts.length === 0) bot(`${svc.name} is fully booked for the rest of today.`, [{ label: "Choose another service", action: "greet" }]);
        else bot("Here's what's available:", opts);
      } catch (err) { setError(err.message); }
    } else if (action === "times") {
      user("Choose another time");
      const { serviceId, slots } = payload;
      const size = 60;
      const groupsBy = (sz) => { const m = new Map(); slots.forEach((t) => { const k = Math.floor(t / sz); m.set(k, [...(m.get(k) || []), t]); }); return m; };
      let groups = groupsBy(size);
      let sz = size;
      if ([...groups.values()].some((g) => g.length > 9)) { sz = 30; groups = groupsBy(sz); }
      const blocks = [...groups.entries()];
      const slotOpts = (list) => list.map((t) => ({ label: `Book ${formatTime(t)} today`, action: "book", payload: { serviceId, slotTime: t } }));
      if (blocks.length === 1 || slots.length <= 9) bot("Pick a time:", slotOpts(slots.slice(0, 9)));
      else bot("Which part of the day suits you?", blocks.slice(0, 9).map(([k, g]) => ({ label: `${formatTime(k * sz)} – ${formatTime(k * sz + sz - 1)} (${g.length} free)`, action: "timeblock", payload: { serviceId, slots: g } })));
    } else if (action === "timeblock") {
      user("Choose a time block");
      bot("Pick a time:", payload.slots.slice(0, 9).map((t) => ({ label: `Book ${formatTime(t)} today`, action: "book", payload: { serviceId: payload.serviceId, slotTime: t } })));
    } else if (action === "join") {
      const svc = services.find((s) => s.id === payload);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "walk_in", date: todayIso(), hourBlock: null });
        bot("You're checked in ✅\nWe'll message you here when it's your turn.", [{ label: "Simulate a new customer", action: "restart" }], {
          number: r.ticket.ticket_number,
          position: r.queue ? r.queue.position : null,
          eta: r.queue && r.queue.estimatedMinutes != null ? `About ${r.queue.estimatedMinutes} min` : null,
          service: svc.name,
        });
        lastStatusRef.current = "waiting";
        setTicketStatus("waiting");
        setQueueInfo(r.queue || null);
        setWatchedTicket({ id: r.ticket.id, ticketNumber: r.ticket.ticket_number, type: "walk_in" });
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "book") {
      const svc = services.find((s) => s.id === payload.serviceId);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "booked", date: todayIso(), slotTime: payload.slotTime });
        bot("You're booked ✅\nWe'll message you here when it's your turn.", [{ label: "Simulate a new customer", action: "restart" }], {
          number: r.ticket.ticket_number,
          position: null,
          eta: `${formatTime(payload.slotTime)} today`,
          etaLabel: "Appointment",
          service: svc.name,
        });
        lastStatusRef.current = "booked";
        setTicketStatus("booked");
        setQueueInfo(null);
        setWatchedTicket({ id: r.ticket.id, ticketNumber: r.ticket.ticket_number, type: "booked", slotTime: payload.slotTime });
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "website") {
      window.open(payload, "_blank", "noopener");
    } else if (action === "restart") {
      setWatchedTicket(null);
      setTicketStatus(null);
      setQueueInfo(null);
      lastStatusRef.current = null;
      setServiceName("");
      setMessages([{ from: "bot", text: `Welcome to ${businessName} 👋 Reply Hi to get a ticket or book a slot.` }]);
      setOptions([{ label: "Hi", action: "greet" }]);
    }
  }

  // Only shows services that are actually open right now — closed/out-of-hours ones never
  // appear as options at all, rather than letting the customer pick one only to be told no.
  async function showServices(locId) {
    const list = services.filter((s) => s.location_id === locId);
    const location = locations.find((l) => l.id === locId);
    if (list.length === 0) {
      bot("There aren't any services set up here yet.");
      return;
    }
    let checks;
    try {
      checks = await Promise.all(list.map(async (s) => {
        try {
          const r = await api.getAvailability(tenantId, s.id, todayIso(), nowMinutes());
          return { service: s, open: r.open, reason: r.reason };
        } catch {
          return { service: s, open: false, reason: "error" };
        }
      }));
    } catch (err) {
      setError(err.message);
      return;
    }
    const liveServices = checks.filter((c) => c.open).map((c) => c.service);
    if (liveServices.length === 0) {
      const reasons = new Set(checks.map((c) => c.reason));
      let text = "We're not open right now — nothing here is available today. Please check back during opening hours.";
      if (reasons.size === 1) {
        const reason = [...reasons][0];
        if (reason === "outside_license_window") text = "This service's license doesn't cover today's date — please contact the business directly.";
        else if (reason === "paused") text = "We're temporarily paused right now — please try again shortly.";
      }
      const opts = [];
      if (location?.website_url) opts.push({ label: "See opening hours", action: "website", payload: location.website_url });
      bot(text, opts);
      return;
    }
    bot("Which service would you like today?", liveServices.map((s) => ({ label: s.name, action: "svc", payload: s.id })));
  }

  if (notFound) {
    return <div className="narrow card screen-error" role="alert">We couldn't find that business. Check the link and try again.</div>;
  }

  const showStatus = watchedTicket && (ticketStatus === "waiting" || ticketStatus === "booked");

  return (
    <div className="app">
      <header className="chat-head">
        <span className="chat-avatar" aria-hidden="true">{(businessName || "Q").trim().charAt(0).toUpperCase()}</span>
        <div className="chat-head-text">
          <h1 className="chat-title">{businessName || "QBooker"}</h1>
          <p className="chat-sub">{serviceName || "Queue & bookings"}</p>
        </div>
      </header>
      {error && (
        <div className="chat-error" role="alert">
          <span>{error}</span>
          <button className="btn-outline" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-list" role="log" aria-live="polite" aria-label="Conversation">
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.from}`}>
              <div className="bubble">{m.text}</div>
              {m.ticket && (
                <div className="ticket" aria-label={`Ticket ${m.ticket.number}`}>
                  <div className="ticket-top">
                    <span className="ticket-label">Your ticket{m.ticket.service ? ` · ${m.ticket.service}` : ""}</span>
                    <span className="ticket-num mono">{m.ticket.number}</span>
                  </div>
                  <dl className="ticket-meta">
                    {m.ticket.position != null && (
                      <div><dt>Position</dt><dd>#{m.ticket.position}</dd></div>
                    )}
                    {m.ticket.eta && (
                      <div><dt>{m.ticket.etaLabel || "Estimated wait"}</dt><dd>{m.ticket.eta}</dd></div>
                    )}
                  </dl>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <footer className="chat-foot">
        {options.length > 0 && (
          <div className="replies" role="group" aria-label="Reply options">
            {options.map((o, i) => (
              <button
                key={i}
                type="button"
                className={`reply${pickedIdx === i ? " is-picked" : ""}${o.action === "restart" ? " reply-quiet" : ""}`}
                disabled={o.disabled}
                aria-pressed={pickedIdx === i}
                onClick={() => { if (!o.disabled) { setPickedIdx(i); handle(o.action, o.payload); } }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {showStatus && (
          <div className="status-bar">
            <p className="status-text">
              {watchedTicket.type === "walk_in" && queueInfo && (
                <>You're <strong>#{queueInfo.position}</strong> in line{queueInfo.estimatedMinutes != null && ` — about ${queueInfo.estimatedMinutes} min`}</>
              )}
              {watchedTicket.type === "walk_in" && !queueInfo && <>You're in the queue</>}
              {watchedTicket.type === "booked" && <>Booked for <strong>{formatTime(watchedTicket.slotTime)}</strong> today</>}
            </p>
            <div className="status-actions">
              {watchedTicket.type === "booked" && (arrived
                ? <span className="badge badge-green checked">✓ Checked in</span>
                : <button className="btn btn-accent btn-checkin" disabled={checkingIn} onClick={checkInNow}>{checkingIn ? "Checking in…" : "Check in"}</button>)}
              <button className="btn-outline danger" disabled={cancelling} onClick={cancelMyTicket}>
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
