import { useState, useEffect } from "react";
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

  function bot(text, opts) { setMessages((m) => [...m, { from: "bot", text }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text }]); }

  async function handle(action, payload) {
    if (action === "greet") {
      user("Hi");
      if (locations.length > 1) bot("Which location?", locations.map((l) => ({ label: l.name, action: "loc", payload: l.id })));
      else showServices(locations[0]?.id);
    } else if (action === "loc") {
      user(locations.find((l) => l.id === payload)?.name);
      showServices(payload);
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
        bot(`You're checked in ✅ Your ticket number: ${r.ticket.ticket_number}`, [{ label: "Simulate a new customer", action: "restart" }]);
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "book") {
      const svc = services.find((s) => s.id === payload.serviceId);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "booked", date: todayIso(), slotTime: payload.slotTime });
        bot(`You're booked ✅ ${formatTime(payload.slotTime)} today. Ticket: ${r.ticket.ticket_number}`, [{ label: "Simulate a new customer", action: "restart" }]);
      } catch (err) { bot(`Sorry — ${err.message}`); }
    } else if (action === "restart") {
      setMessages([{ from: "bot", text: `Welcome to ${businessName} 👋 Reply Hi to get a ticket or book a slot.` }]);
      setOptions([{ label: "Hi", action: "greet" }]);
    }
  }
  function showServices(locId) {
    const list = services.filter((s) => s.location_id === locId);
    bot("Which service would you like today?", list.map((s) => ({ label: s.name, action: "svc", payload: s.id })));
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
          {messages.map((m, i) => <div key={i} style={{ textAlign: m.from === "user" ? "right" : "left" }}>{m.text}</div>)}
          <div className="wrap">
            {options.map((o, i) => <button key={i} className="btn-outline" onClick={() => handle(o.action, o.payload)}>{o.label}</button>)}
          </div>
        </div>
      </div>
    </div>
  );
}
