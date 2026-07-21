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
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("c") || "");
  const [manualEntry, setManualEntry] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="container muted" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  if (!code) {
    return (
      <div className="narrow card stack" style={{ marginTop: 60 }}>
        <h3>QBooker</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          This page needs a location code to know where you're checking in — normally you'd arrive
          here by scanning a QR code or tapping a WhatsApp link at the location. For testing, enter
          the code shown against a location in the Admin portal (e.g. QB-7F3K2A).
        </p>
        <input className="input" placeholder="Location code" value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} />
        <button className="btn" disabled={!manualEntry.trim()} onClick={() => setCode(manualEntry.trim())}>Continue</button>
      </div>
    );
  }

  return <CustomerWhatsApp code={code} />;
}

function CustomerWhatsApp({ code }) {
  const [error, setError] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [tenantId, setTenantId] = useState(null);
  const [locationId, setLocationId] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState([]);
  const [services, setServices] = useState([]);
  const [options, setOptions] = useState([]);

  useEffect(() => {
    api.lookupCode(code)
      .then((info) => {
        setBusinessName(info.businessName);
        setLocationName(info.locationName);
        setTenantId(info.tenantId);
        setLocationId(info.locationId);
        return api.getServices(info.tenantId);
      })
      .then((s) => {
        setServices(s.services);
        setMessages([{ from: "bot", text: `Welcome to ${businessName || "us"} 👋 Reply Hi to get a ticket or book a slot.` }]);
      })
      .catch(() => setNotFound(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Set the initial greeting once we actually know the business name (avoids a stale closure).
  useEffect(() => {
    if (businessName && messages.length === 0) {
      setMessages([{ from: "bot", text: `Welcome to ${businessName} 👋 Reply Hi to get a ticket or book a slot.` }]);
      setOptions([{ label: "Hi", action: "greet" }]);
    }
  }, [businessName]); // eslint-disable-line react-hooks/exhaustive-deps

  function bot(text, opts) { setMessages((m) => [...m, { from: "bot", text }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text }]); }

  async function handle(action, payload) {
    if (action === "greet") {
      user("Hi");
      showServices();
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
  function showServices() {
    // The location code already identifies which location we're at — no need to ask.
    const list = services.filter((s) => s.location_id === locationId);
    if (list.length === 0) { bot("No services are set up at this location yet."); return; }
    bot("Which service would you like today?", list.map((s) => ({ label: s.name, action: "svc", payload: s.id })));
  }

  if (notFound) {
    return <div className="narrow card" style={{ marginTop: 60, color: "#C22A1E" }}>We couldn't recognise that code. Check the link/QR code and try again.</div>;
  }

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <strong>{businessName ? `${businessName}${locationName ? " — " + locationName : ""}` : "QBooker"}</strong>
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
