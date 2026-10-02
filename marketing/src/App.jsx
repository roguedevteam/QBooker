import { useState, useEffect } from "react";
import { api } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || "http://localhost:5173";

const PLAN_META = [
  { id: "day", label: "Day pass", days: 1, desc: "One day of access, until midnight." },
  { id: "week", label: "Week", days: 7, desc: "Seven days of access." },
  { id: "month", label: "Month", days: 30, desc: "30 days of access." },
  { id: "year", label: "Year", days: 365, desc: "365 days of access — best value for ongoing use." },
  { id: "custom", label: "Custom", days: null, desc: "Choose exactly how many days you need." },
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

const FEATURES = [
  { icon: "⚡", title: "Rapid setup", text: "Sign up and be live in about 3 minutes — no onboarding call required." },
  { icon: "🔀", title: "Queue, appointments, or both", text: "Set each service to queue-only, appointment-only, or hybrid — your choice, changeable anytime." },
  { icon: "📄", title: "No lock-in contracts", text: "Pay for exactly the period you need — a day, a week, a month, or a year. Nothing auto-renews behind your back." },
  { icon: "📍", title: "Priced per location", text: "One simple price per location, not per seat or per staff member." },
  { icon: "👥", title: "Unlimited by design", text: "Unlimited staff, unlimited services, unlimited appointments — no artificial caps to hit." },
  { icon: "🧭", title: "Flexible from day one", text: "Change plans, add locations, and reconfigure services as your business changes." },
];

function Landing({ onStart }) {
  const [pricing, setPricing] = useState(null);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  return (
    <div>
      <div className="container stack" style={{ textAlign: "center", paddingTop: 60 }}>
        <h1>Let customers join the queue or book a slot — from a WhatsApp message.</h1>
        <p className="muted">No app to install. Set up services, hours, and slots in minutes.</p>
        <div><button className="btn" onClick={onStart}>Get started</button></div>
      </div>

      <div className="container" style={{ marginTop: 48 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="card stack" style={{ gap: 6 }}>
              <div style={{ fontSize: 22 }}>{f.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{f.title}</div>
              <div className="muted" style={{ fontSize: 13 }}>{f.text}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="container" style={{ marginTop: 40 }}>
        <div className="card stack">
          <div style={{ fontWeight: 600 }}>Reliability</div>
          <p className="muted" style={{ fontSize: 13 }}>
            We take uptime seriously — this is where you'd state your specific commitment (e.g. a target
            percentage or response-time promise) once you've decided what you're comfortable guaranteeing.
          </p>
        </div>
      </div>

      <div className="container" style={{ marginTop: 24 }}>
        <div className="card row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 600 }}>Want a hand getting set up?</div>
            <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
              Our team will configure your services, hours, and staff for you — done in one session.
            </p>
          </div>
          <div className="row">
            <strong>£125</strong>
            <a href="mailto:hello@qbooker.example?subject=Setup%20assistance"><button className="btn-outline">Get in touch</button></a>
          </div>
        </div>
      </div>

      <div className="container" style={{ marginTop: 24 }}>
        <div className="card stack">
          <div style={{ fontWeight: 600 }}>Just need a simple queue?</div>
          <p className="muted" style={{ fontSize: 13 }}>
            If you already use Microsoft Bookings for appointments and only need queue management,
            we offer integration on request — <a href="mailto:hello@qbooker.example?subject=MS%20Bookings%20integration">get in touch</a> to discuss your setup.
          </p>
        </div>
      </div>

      <div className="container" style={{ marginTop: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          <div className="card stack" style={{ gap: 4 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>🇬🇧 UK-hosted</div>
            <div className="muted" style={{ fontSize: 12 }}>Your data stays in the UK, hosted with providers built for reliability.</div>
          </div>
          <div className="card stack" style={{ gap: 4 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>🔒 Secure by design</div>
            <div className="muted" style={{ fontSize: 12 }}>Every sign-in is one-time-code based — no passwords to leak or reuse.</div>
          </div>
          <div className="card stack" style={{ gap: 4 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>♿ Accessible</div>
            <div className="muted" style={{ fontSize: 12 }}>Built with clear contrast, large touch targets, and simple navigation throughout.</div>
          </div>
        </div>
      </div>

      {pricing && (
        <div className="container" style={{ marginTop: 40 }}>
          <h2 style={{ textAlign: "center", fontSize: 20 }}>Try it before you commit</h2>
          <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>Buy exactly as much time as you need to test it properly — per location.</p>
          {pricing.sale?.active && (
            <p style={{ textAlign: "center", fontSize: 13, color: "#00522A", fontWeight: 600 }}>Sale on selected plans — see below</p>
          )}
          <div className="wrap" style={{ justifyContent: "center" }}>
            {["day", "week", "month", "year"].map((k) => {
              const label = { day: "Day pass", week: "Week", month: "Month", year: "Year" }[k];
              const onSale = pricing.sale?.active && pricing.sale[k] != null;
              return (
                <div key={k} className="card stack" style={{ minWidth: 140, textAlign: "center" }}>
                  {onSale && <span className="muted" style={{ fontSize: 13, textDecoration: "line-through" }}>£{pricing[k]}</span>}
                  <strong style={{ color: onSale ? "#00522A" : undefined }}>£{onSale ? pricing.sale[k] : pricing[k]}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{label}</span>
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ textAlign: "center", fontSize: 12 }}>All prices per location. Need something in between? Choose a custom period at signup.</p>
        </div>
      )}

      <div className="container" style={{ marginTop: 40, marginBottom: 60 }}>
        <h2 style={{ textAlign: "center", fontSize: 20 }}>Questions</h2>
        <div className="stack" style={{ maxWidth: 640, margin: "0 auto" }}>
          <FaqItem q="Do I have to sign a contract?" a="No. You buy access for a day, week, month, or year at a time — nothing auto-renews, and there's no minimum term." />
          <FaqItem q="What if I only need a queue, not appointments?" a="Set any service to queue-only in a couple of clicks — or use hybrid mode to offer both walk-ins and bookings side by side." />
          <FaqItem q="Is there a limit on staff or services?" a="No — every plan includes unlimited staff, services, and appointments. You're only charged per location." />
          <FaqItem q="How long does setup actually take?" a="Most businesses are live in about 3 minutes — business name, a plan, your first location, and you're in. If you'd rather have it done for you, we offer paid setup assistance." />
        </div>
      </div>

      <div className="container stack" style={{ textAlign: "center", marginBottom: 60 }}>
        <button className="btn" onClick={onStart}>Get started</button>
      </div>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <strong style={{ fontSize: 14 }}>{q}</strong>
        <span className="muted">{open ? "−" : "+"}</span>
      </div>
      {open && <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>{a}</p>}
    </div>
  );
}

function Success({ result }) {
  if (result.alreadyExists) {
    return (
      <div className="narrow card stack" style={{ marginTop: 60 }}>
        <h3>Welcome back 👋</h3>
        <p>An account for <strong>{result.businessName}</strong> already exists with that email — we've sent a fresh sign-in code instead of creating a new one.</p>
        <div className="card">Demo sign-in code (simulated email): <strong>{result.demoOtp}</strong></div>
        <a href={ADMIN_APP_URL}><button className="btn">Go to admin sign-in →</button></a>
      </div>
    );
  }
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

const STEP_LABELS = ["Your details", "Pass & locations", "Payment"];

function StepHeader({ step }) {
  return (
    <div className="row" style={{ justifyContent: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="row" style={{ gap: 6, alignItems: "center" }}>
            <span
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, borderRadius: "50%", fontSize: 12, fontWeight: 600,
                background: active || done ? "#00522A" : "#eee",
                color: active || done ? "#fff" : "#777",
              }}
            >
              {done ? "✓" : n}
            </span>
            <span className="muted" style={{ fontSize: 12, color: active ? "#00522A" : undefined, fontWeight: active ? 600 : 400 }}>{label}</span>
            {n < STEP_LABELS.length && <span className="muted" style={{ fontSize: 12 }}>—</span>}
          </div>
        );
      })}
    </div>
  );
}

// Joins the 4 address parts into the single string the server stores, dropping any that are blank.
function combineAddress(line1, line2, city, postcode) {
  return [line1, line2, city, postcode].map((s) => (s || "").trim()).filter(Boolean).join(", ");
}

function AddressFields({ line1, line2, city, postcode, onChange, required }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input className="input" placeholder={`Address line 1${required ? "" : " (optional)"}`} value={line1} onChange={(e) => onChange("line1", e.target.value)} />
      <input className="input" placeholder="Address line 2 (optional)" value={line2} onChange={(e) => onChange("line2", e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <input className="input" placeholder="City" value={city} onChange={(e) => onChange("city", e.target.value)} style={{ flex: 1 }} />
        <input className="input" placeholder="Post / zip code" value={postcode} onChange={(e) => onChange("postcode", e.target.value)} style={{ flex: 1 }} />
      </div>
    </div>
  );
}

function Signup({ onDone, setError }) {
  const [step, setStep] = useState(1);

  // Step 1 — contact & business details
  const [businessName, setBusinessName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [companyLine1, setCompanyLine1] = useState("");
  const [companyLine2, setCompanyLine2] = useState("");
  const [companyCity, setCompanyCity] = useState("");
  const [companyPostcode, setCompanyPostcode] = useState("");

  // Step 2 — pass + locations (combined, since the pass decides the per-location price)
  const [planId, setPlanId] = useState("month");
  const [customDays, setCustomDays] = useState(14);
  const [locationNames, setLocationNames] = useState([""]);
  const locationCount = locationNames.length;
  const MAX_LOCATIONS = 20;

  // Step 3 — payment
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [invoiceEmail, setInvoiceEmail] = useState("");
  const [poNumber, setPoNumber] = useState("");

  const [pricing, setPricing] = useState({ day: 25, week: 100, month: 200, year: 600, customDailyRate: 20, sale: { active: false } });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  function addLocation() {
    setLocationNames((prev) => (prev.length >= MAX_LOCATIONS ? prev : [...prev, ""]));
  }

  function removeLocation(i) {
    setLocationNames((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  function updateLocationName(i, value) {
    setLocationNames((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }

  const selectedPlan = PLAN_META.find((p) => p.id === planId);
  const salePrice = pricing.sale?.active && planId !== "custom" ? pricing.sale[planId] : null;
  const perLocation = planId === "custom" ? customDays * pricing.customDailyRate : (salePrice ?? pricing[planId]);
  const total = (perLocation * locationCount).toFixed(2);

  const step1Valid = businessName.trim() && firstName.trim() && lastName.trim() && email.trim();
  const activeNames = locationNames.map((n) => n.trim());
  const namesFilled = activeNames.every((n) => n);
  const normalizedNames = activeNames.map((n) => n.toLowerCase());
  const hasDuplicateNames = namesFilled && new Set(normalizedNames).size !== normalizedNames.length;
  const step2Valid = namesFilled && !hasDuplicateNames;
  const step3Valid = paymentMethod === "card" || (invoiceEmail.trim() && poNumber.trim());

  function next() { setStep((s) => Math.min(3, s + 1)); }
  function back() { setStep((s) => Math.max(1, s - 1)); }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const plan = PLAN_META.find((p) => p.id === planId);
      const planDays = planId === "custom" ? customDays : plan.days;
      const payload = {
        businessName, firstName, lastName, email,
        companyAddress: combineAddress(companyLine1, companyLine2, companyCity, companyPostcode),
        planId, planLabel: planId === "custom" ? `${customDays}-day custom plan` : plan.label,
        planDays, price: total, pricePerLocation: perLocation, locationCount,
        paymentMethod, invoiceEmail, invoicePO: poNumber,
        locationNames: locationNames.slice(0, locationCount),
      };
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
      <h2 style={{ textAlign: "center" }}>Set up your account</h2>
      <StepHeader step={step} />

      {step === 1 && (
        <div className="stack">
          <input className="input" placeholder="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
          <div className="row" style={{ gap: 8 }}>
            <input className="input" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} style={{ flex: 1 }} />
            <input className="input" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} style={{ flex: 1 }} />
          </div>
          <div>
            <input className="input" placeholder="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>This is what you'll sign in with — we'll send a one-time code here each time, no password to remember.</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Company address (optional)</div>
            <AddressFields
              line1={companyLine1} line2={companyLine2} city={companyCity} postcode={companyPostcode}
              onChange={(field, value) => {
                if (field === "line1") setCompanyLine1(value);
                if (field === "line2") setCompanyLine2(value);
                if (field === "city") setCompanyCity(value);
                if (field === "postcode") setCompanyPostcode(value);
              }}
            />
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={!step1Valid} onClick={next}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="stack">
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>What sort of access do you need?</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              You're not choosing a start date — access begins automatically the moment you set opening hours for
              your first service, whenever you're actually ready. Nothing is wasted while you're still setting up.
            </div>
            <div className="wrap">
              {PLAN_META.map((p) => (
                <button key={p.id} className={planId === p.id ? "btn" : "btn-outline"} onClick={() => setPlanId(p.id)}>{p.label}</button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{selectedPlan?.desc}</div>
            {planId === "custom" && (
              <div className="row" style={{ marginTop: 8 }}><span className="muted">Days:</span><input className="input" type="number" min={1} value={customDays} onChange={(e) => setCustomDays(Number(e.target.value))} /></div>
            )}
          </div>

          <div className="card row" style={{ justifyContent: "space-between", alignItems: "center", background: "#F4F9F6" }}>
            <span className="muted" style={{ fontSize: 12 }}>£{perLocation} × {locationCount} location{locationCount === 1 ? "" : "s"}</span>
            <strong>Total: £{total}</strong>
          </div>

          <div className="muted" style={{ fontSize: 11 }}>
            Name each location now — each name must be unique. Once you're in, you'll just need to add services,
            set working hours, and pick the dates you're open.
          </div>
          <div className="stack">
            {locationNames.map((name, i) => (
              <div key={i} className="row" style={{ gap: 6 }}>
                <input
                  className="input"
                  placeholder={`Location ${i + 1} name`}
                  value={name}
                  onChange={(e) => updateLocationName(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn-outline"
                  onClick={() => removeLocation(i)}
                  disabled={locationNames.length <= 1}
                  title={locationNames.length <= 1 ? "At least one location is required" : "Remove this location"}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div>
            <button className="btn-outline" onClick={addLocation} disabled={locationNames.length >= MAX_LOCATIONS}>+ Add location</button>
          </div>
          {hasDuplicateNames && (
            <div style={{ fontSize: 12, color: "#942A21", fontWeight: 500 }}>
              Each location needs its own name — two locations currently share the same name.
            </div>
          )}

          <div className="card row" style={{ justifyContent: "space-between", alignItems: "center", background: "#F4F9F6" }}>
            <span className="muted" style={{ fontSize: 12 }}>£{perLocation} × {locationCount} location{locationCount === 1 ? "" : "s"}</span>
            <strong>Total: £{total}</strong>
          </div>

          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn-outline" onClick={back}>Back</button>
            <button className="btn" disabled={!step2Valid} onClick={next}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>How would you like to pay?</div>
            <div className="wrap">
              <button className={paymentMethod === "card" ? "btn" : "btn-outline"} onClick={() => setPaymentMethod("card")}>Card</button>
              <button className={paymentMethod === "invoice" ? "btn" : "btn-outline"} onClick={() => setPaymentMethod("invoice")}>Invoice</button>
            </div>
          </div>
          {paymentMethod === "card" && (
            <div className="muted" style={{ fontSize: 12 }}>
              Card payment integration via Stripe is coming soon — for now, your account is activated immediately
              without taking a real charge.
            </div>
          )}
          {paymentMethod === "invoice" && (
            <div className="stack">
              <input className="input" placeholder="Billing email" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
              <div>
                <input className="input" placeholder="PO / reference number" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Required for invoice payment — your internal purchase order or reference number.</div>
              </div>
              <div style={{ fontSize: 12, color: "#942A21", fontWeight: 500 }}>
                With invoice payment, your account can be fully configured straight away, but staff kiosk and customer
                WhatsApp won't be enabled until payment is received.
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Total: <strong>£{total}</strong>{salePrice != null && <span className="muted" style={{ fontSize: 12 }}> (sale price applied)</span>}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn-outline" onClick={back}>Back</button>
            <button className="btn" disabled={submitting || !step3Valid} onClick={submit}>{submitting ? "Processing…" : "Create account"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
