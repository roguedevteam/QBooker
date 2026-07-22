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
  const [watchedTicket, setWatchedTicket] = useState(null); // { id, ticketNumber }
  const lastStatusRef = useRef(null);

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
  useEffect(() => {
    if (!watchedTicket) return;
    const id = setInterval(async () => {
      try {
        const r = await api.getTicketStatus(tenantId, watchedTicket.id);
        if (r.status === "seen" && lastStatusRef.current !== "seen") {
          bot(`📍 ${r.message || "It's your turn! Please head to the desk."}`);
        }
        lastStatusRef.current = r.status;
      } catch {
        // ignore transient errors, try again next tick
      }
    }, 6000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedTicket, tenantId]);

  function bot(text, opts) { setMessages((m) => [...m, { from: "bot", text }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text }]); }

  async function handle(action, payload) {
    if (action === "greet") {
      user("Hi");
      if (locations.length > 1) bot("Which location?", locations.map((l) => ({ label: l.name, action: "loc", payload: l.id })));
      else await showServices(locations[0]?.id);
    } else if (action === "loc") {
      user(locations.find((l) => l.id === payload)?.name);
      await showServices(payload);
    } else if (action === "svc") {
      const svc = services.find((s) => s.id === payload);
      user(svc.name);
      try {
        const r = await api.getAvailability(tenantId, svc.id, todayIso(), nowMinutes());
        if (!r.open) {
          bot(r.reason === "outside_plan_window" ? "We're not taking bookings today." : `${svc.name} isn't available right now.`, [{ label: "Choose another service", action: "greet" }]);
          return;
        }
        const opts = [];
        if (r.walkIn?.available) opts.push({ label: "Join the queue now", action: "join", payload: svc.id });
        (r.bookableSlots || []).forEach((t) => opts.push({ label: `Book ${formatTime(t)} today`, action: "book", payload: { serviceId: svc.id, slotTime: t } }));
        if (opts.length === 0) bot(`${svc.name} is fully booked for the rest of today.`, [{ label: "Choose another service", action: "greet" }]);
        else bot("Here's what's available:", opts);
      } catch (err) { setError(err.message); }
    } else if (action === "join") {
      const svc = services.find((s) => s.id === payload);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "walk_in", date: todayIso(), hourBlock: null });
        bot(`You're checked in ✅ Your ticket number: ${r.ticket.ticket_number}\nWe'll message you here when it's your turn.`, [{ label: "Simulate a new customer", action: "restart" }]);
        lastStatusRef.current = "waiting";
        setWatchedTicket({ id: r.ticket.id, ticketNumber: r.ticket.ticket_number });
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "book") {
      const svc = services.find((s) => s.id === payload.serviceId);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "booked", date: todayIso(), slotTime: payload.slotTime });
        bot(`You're booked ✅ ${formatTime(payload.slotTime)} today. Ticket: ${r.ticket.ticket_number}\nWe'll message you here when it's your turn.`, [{ label: "Simulate a new customer", action: "restart" }]);
        lastStatusRef.current = "booked";
        setWatchedTicket({ id: r.ticket.id, ticketNumber: r.ticket.ticket_number });
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "website") {
      window.open(payload, "_blank", "noopener");
    } else if (action === "restart") {
      setWatchedTicket(null);
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
        if (reason === "outside_plan_window") text = "This location's license doesn't cover today's date — please contact the business directly.";
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
    return <div className="narrow card" style={{ marginTop: 60, color: "#C22A1E" }}>We couldn't find that business. Check the link and try again.</div>;
  }

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <strong>{businessName || "QBooker"}</strong>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#C22A1E", color: "#C22A1E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}
      <div className="narrow stack">
        <div className="card stack" style={{ minHeight: 300 }}>
          {messages.map((m, i) => <div key={i} style={{ textAlign: m.from === "user" ? "right" : "left", whiteSpace: "pre-line" }}>{m.text}</div>)}
          <div className="wrap">
            {options.map((o, i) => <button key={i} className="btn-outline" onClick={() => handle(o.action, o.payload)}>{o.label}</button>)}
          </div>
        </div>
      </div>
    </div>
  );
}
