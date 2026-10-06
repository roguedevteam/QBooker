import { useState, useEffect, useRef } from "react";
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

  if (!ready) return <div className="container muted" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  if (!tenantId) {
    return (
      <div className="narrow card stack" style={{ marginTop: 60 }}>
        <h3>QBooker</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          This page needs a business link to know who you're booking with — normally you'd arrive here
          via a link shared by the business. For testing, paste the business ID shown in their Admin portal.
        </p>
        <input className="input" placeholder="Business ID" value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} />
        <button className="btn" disabled={!manualEntry.trim()} onClick={() => setTenantId(manualEntry.trim())}>Continue</button>
      </div>
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

  function bot(text, opts) { setMessages((m) => [...m, { from: "bot", text }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text }]); }

  async function handle(action, payload) {
    if (action === "greet") {
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
        slots.slice(0, 3).forEach((t) => opts.push({ label: `Book ${formatTime(t)} today`, action: "book", payload: { serviceId: svc.id, slotTime: t } }));
        if (slots.length > 3) opts.push({ label: `See other times (${slots.length - 3} more)`, action: "times", payload: { serviceId: svc.id, slots: slots.slice(3) } });
        if (opts.length === 0) bot(`${svc.name} is fully booked for the rest of today.`, [{ label: "Choose another service", action: "greet" }]);
        else bot("Here's what's available:", opts);
      } catch (err) { setError(err.message); }
    } else if (action === "times") {
      user("See other times");
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
        let text = `You're checked in ✅ Your ticket number: ${r.ticket.ticket_number}\n`;
        if (r.queue) {
          text += `You're #${r.queue.position} in line`;
          if (r.queue.estimatedMinutes != null) text += ` — about ${r.queue.estimatedMinutes} min`;
          text += `.\n`;
        }
        text += `We'll message you here when it's your turn.`;
        bot(text, [{ label: "Simulate a new customer", action: "restart" }]);
        lastStatusRef.current = "waiting";
        setTicketStatus("waiting");
        setQueueInfo(r.queue || null);
        setWatchedTicket({ id: r.ticket.id, ticketNumber: r.ticket.ticket_number, type: "walk_in" });
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "book") {
      const svc = services.find((s) => s.id === payload.serviceId);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "booked", date: todayIso(), slotTime: payload.slotTime });
        bot(`You're booked ✅ ${formatTime(payload.slotTime)} today. Ticket: ${r.ticket.ticket_number}\nWe'll message you here when it's your turn.`, [{ label: "Simulate a new customer", action: "restart" }]);
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
    return <div className="narrow card" style={{ marginTop: 60, color: "var(--error)" }}>We couldn't find that business. Check the link and try again.</div>;
  }

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <strong>{businessName || "QBooker"}</strong>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "var(--error)", color: "var(--error)" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}
      <div className="narrow stack">
        <div className="card stack" style={{ minHeight: 300 }}>
          {messages.map((m, i) => <div key={i} style={{ textAlign: m.from === "user" ? "right" : "left", whiteSpace: "pre-line" }}>{m.text}</div>)}
          <div className="wrap">
            {options.map((o, i) => (
              <button
                key={i}
                className="btn-outline"
                disabled={o.disabled}
                style={o.disabled ? { opacity: 0.5, cursor: "default" } : undefined}
                onClick={() => { if (!o.disabled) handle(o.action, o.payload); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {watchedTicket && (ticketStatus === "waiting" || ticketStatus === "booked") && (
          <div className="card row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13 }}>
              {watchedTicket.type === "walk_in" && queueInfo && (
                <>You're <strong>#{queueInfo.position}</strong> in line{queueInfo.estimatedMinutes != null && ` — about ${queueInfo.estimatedMinutes} min`}</>
              )}
              {watchedTicket.type === "booked" && <>Booked for {formatTime(watchedTicket.slotTime)} today</>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {watchedTicket.type === "booked" && (arrived
                ? <span className="badge badge-green">✓ Checked in</span>
                : <button className="btn" disabled={checkingIn} onClick={checkInNow}>{checkingIn ? "Checking in…" : "Check in"}</button>)}
              <button className="btn-outline" style={{ color: "var(--error)" }} disabled={cancelling} onClick={cancelMyTicket}>
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
