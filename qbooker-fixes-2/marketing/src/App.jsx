import { useState, useEffect } from "react";
import { api } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || "http://localhost:5173";

const PLAN_META = [
  { id: "day", label: "Day pass", days: 1 },
  { id: "week", label: "Week", days: 7 },
  { id: "month", label: "Month", days: 30 },
  { id: "year", label: "Year", days: 365 },
  { id: "custom", label: "Custom", days: null },
];

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { tenant, demoOtp } after a successful signup
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="container muted" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <strong>QBooker</strong>
        <div className="row">
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
          <a href={ADMIN_APP_URL} style={{ color: "#fff", fontSize: 13 }}>Already have an account? Admin sign-in →</a>
        </div>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#C22A1E", color: "#C22A1E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "landing" && <Landing onStart={() => setScreen("signup")} />}
      {screen === "signup" && <Signup setError={setError} onDone={(r) => { setResult(r); setScreen("success"); }} />}
      {screen === "success" && result && <Success result={result} />}
    </div>
  );
}

function Landing({ onStart }) {
  return (
    <div className="container stack" style={{ textAlign: "center", paddingTop: 60 }}>
      <h1>Let customers join the queue or book a slot — from a WhatsApp message.</h1>
      <p className="muted">No app to install. Set up services, hours, and slots in minutes.</p>
      <div><button className="btn" onClick={onStart}>Get started</button></div>
    </div>
  );
}

function Success({ result }) {
  return (
    <div className="narrow card stack" style={{ marginTop: 60 }}>
      <h3>You're set up ✅</h3>
      <p>Account created for <strong>{result.tenant.business_name}</strong>.</p>
      <div className="card">Demo sign-in code (simulated email): <strong>{result.demoOtp}</strong></div>
      <p className="muted" style={{ fontSize: 13 }}>
        Head to the admin portal and sign in with <strong>{result.tenant.email}</strong> and the code above.
      </p>
      <a href={ADMIN_APP_URL}><button className="btn">Go to admin sign-in →</button></a>
    </div>
  );
}

function Signup({ onDone, setError }) {
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [planId, setPlanId] = useState("month");
  const [customDays, setCustomDays] = useState(14);
  const [activeDate, setActiveDate] = useState(todayIso());
  const [weekStartDate, setWeekStartDate] = useState(todayIso());
  const [startDate, setStartDate] = useState(todayIso());
  const [locationCount, setLocationCount] = useState(1);
  const [locationNames, setLocationNames] = useState([""]);
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [invoiceEmail, setInvoiceEmail] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [pricing, setPricing] = useState({ day: 25, week: 100, month: 200, year: 600, customDailyRate: 20 });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  function setCount(n) {
    const count = Math.max(1, Math.min(20, n));
    setLocationCount(count);
    setLocationNames((prev) => {
      const next = prev.slice(0, count);
      while (next.length < count) next.push("");
      return next;
    });
  }

  const perLocation = planId === "custom" ? customDays * pricing.customDailyRate : pricing[planId];
  const total = (perLocation * locationCount).toFixed(2);

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const plan = PLAN_META.find((p) => p.id === planId);
      const planDays = planId === "custom" ? customDays : plan.days;
      const payload = {
        businessName, email, planId, planLabel: planId === "custom" ? `${customDays}-day custom plan` : plan.label,
        planDays, price: total, pricePerLocation: perLocation, locationCount,
        paymentMethod, invoiceEmail, invoicePO: poNumber,
        locationNames, locationAddresses: locationNames.map(() => ""),
      };
      if (planId === "day") payload.activeDate = activeDate;
      if (planId === "week") payload.weekStartDate = weekStartDate;
      if (["month", "year", "custom"].includes(planId)) payload.startDate = startDate;
      const result = await api.signup(payload);
      onDone(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="narrow stack">
      <h2>Set up your account</h2>
      <input className="input" placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
      <input className="input" placeholder="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div className="wrap">
        {PLAN_META.map((p) => (
          <button key={p.id} className={planId === p.id ? "btn" : "btn-outline"} onClick={() => setPlanId(p.id)}>{p.label}</button>
        ))}
      </div>
      {planId === "custom" && (
        <div className="row"><span className="muted">Days:</span><input className="input" type="number" min={1} value={customDays} onChange={(e) => setCustomDays(Number(e.target.value))} /></div>
      )}
      {planId === "day" && (
        <div className="row"><span className="muted">Which date?</span><input className="input" type="date" min={todayIso()} value={activeDate} onChange={(e) => setActiveDate(e.target.value)} /></div>
      )}
      {planId === "week" && (
        <div className="row"><span className="muted">Week starting:</span><input className="input" type="date" min={todayIso()} value={weekStartDate} onChange={(e) => setWeekStartDate(e.target.value)} /></div>
      )}
      {["month", "year", "custom"].includes(planId) && (
        <div className="row"><span className="muted">Access starts:</span><input className="input" type="date" min={todayIso()} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
      )}
      <div className="row">
        <span className="muted">Locations:</span>
        <button className="btn-outline" onClick={() => setCount(locationCount - 1)}>−</button>
        <span>{locationCount}</span>
        <button className="btn-outline" onClick={() => setCount(locationCount + 1)}>+</button>
      </div>
      {locationNames.map((n, i) => (
        <input key={i} className="input" placeholder={`Location ${i + 1} name`} value={n} onChange={(e) => setLocationNames((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} />
      ))}
      <div>
        <input className="input" placeholder="PO / reference number" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Required — your internal purchase order or reference number for this account.</div>
      </div>
      <div className="wrap">
        <button className={paymentMethod === "card" ? "btn" : "btn-outline"} onClick={() => setPaymentMethod("card")}>Card</button>
        <button className={paymentMethod === "invoice" ? "btn" : "btn-outline"} onClick={() => setPaymentMethod("invoice")}>Invoice</button>
      </div>
      {paymentMethod === "invoice" && (
        <input className="input" placeholder="Billing email" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>Total: <strong>£{total}</strong></span>
        <button className="btn" disabled={submitting || !businessName || !email || !poNumber.trim()} onClick={submit}>{submitting ? "Processing…" : "Create account"}</button>
      </div>
    </div>
  );
}
