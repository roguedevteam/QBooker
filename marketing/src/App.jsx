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

// Shared logo mark — a steel-blue tile with an amber "notch", plus the wordmark.
// `dark` switches the wordmark to a light colour for use on the navy band / header.
function Logo({ size = 28, dark = false, withWord = true }) {
  const r = size / 44; // scale factor relative to the 44px source art
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
        <rect x="2" y="2" width="40" height="40" fill="var(--blue)" />
        <circle cx="42" cy="22" r="7" fill="var(--accent)" />
      </svg>
      {withWord && <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>}
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { tenant, demoOtp } after a successful signup
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="container muted" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  const inCheckout = screen === "signup" || screen === "success";

  return (
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <a href="#top" onClick={() => setScreen("landing")} style={{ textDecoration: "none" }}>
          <Logo dark />
        </a>
        <div className="row">
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
          {!inCheckout && (
            <nav className="row" style={{ gap: 18, marginRight: 8 }}>
              <a href="#features" style={{ color: "#fff", fontSize: 13, opacity: 0.85, textDecoration: "none" }}>Features</a>
              <a href="#pricing" style={{ color: "#fff", fontSize: 13, opacity: 0.85, textDecoration: "none" }}>Pricing</a>
              <a href="#faq" style={{ color: "#fff", fontSize: 13, opacity: 0.85, textDecoration: "none" }}>FAQ</a>
            </nav>
          )}
          <a href={ADMIN_APP_URL} style={{ color: "#fff", fontSize: 13 }}>
            {inCheckout ? "Already have an account? Sign in →" : "Sign in →"}
          </a>
        </div>
      </div>
      {error && <div className="container"><div className="card" style={{ borderColor: "#B3261E", color: "#B3261E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "landing" && <Landing onStart={() => setScreen("signup")} />}
      {screen === "signup" && <Signup setError={setError} onDone={(r) => { setResult(r); setScreen("success"); }} onBackToLanding={() => setScreen("landing")} />}
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

// A full-bleed section band — alternates between the page background and a
// bordered card band so the landing page reads as distinct, scannable sections.
function Section({ id, variant, children }) {
  const cls = variant === "card" ? "band band-card" : variant === "navy" ? "band band-navy" : "band";
  return (
    <div id={id} className={cls}>
      <div className="container">{children}</div>
    </div>
  );
}

function SectionHeading({ title, lead }) {
  return (
    <div className="stack" style={{ textAlign: "center", marginBottom: 28, gap: 6 }}>
      <h2 style={{ fontSize: 22, margin: 0 }}>{title}</h2>
      {lead && <p className="muted" style={{ margin: 0 }}>{lead}</p>}
    </div>
  );
}

function Landing({ onStart }) {
  const [pricing, setPricing] = useState(null);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  return (
    <div id="top">
      <div className="container stack" style={{ textAlign: "center", paddingTop: 60, paddingBottom: 48 }}>
        <h1>Let customers join the queue or book a slot — from a WhatsApp message.</h1>
        <p className="muted">No app to install. Set up services, hours, and slots in minutes.</p>
        <div><button className="btn" onClick={onStart}>Get started</button></div>
      </div>

      <Section id="features" variant="card">
        <SectionHeading title="Everything you need, nothing you don't" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="card stack" style={{ gap: 6 }}>
              <div style={{ fontSize: 22 }}>{f.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{f.title}</div>
              <div className="muted" style={{ fontSize: 13 }}>{f.text}</div>
            </div>
          ))}
        </div>
      </Section>

      {pricing && (
        <Section id="pricing">
          <SectionHeading title="Try it before you commit" lead="Buy exactly as much time as you need to test it properly — per location." />
          {pricing.sale?.active && (
            <p style={{ textAlign: "center", fontSize: 13, color: "var(--accent)", fontWeight: 600, marginTop: -16 }}>Sale on selected plans — see below</p>
          )}
          <div className="wrap" style={{ justifyContent: "center" }}>
            {["day", "week", "month", "year"].map((k) => {
              const label = { day: "Day pass", week: "Week", month: "Month", year: "Year" }[k];
              const onSale = pricing.sale?.active && pricing.sale[k] != null;
              return (
                <div key={k} className="card stack" style={{ minWidth: 140, textAlign: "center" }}>
                  {onSale && <span className="muted" style={{ fontSize: 13, textDecoration: "line-through" }}>£{pricing[k]}</span>}
                  <strong style={{ color: onSale ? "var(--accent)" : undefined }}>£{onSale ? pricing.sale[k] : pricing[k]}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{label}</span>
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ textAlign: "center", fontSize: 12 }}>All prices per location. Need something in between? Choose a custom period at signup.</p>
        </Section>
      )}

      <Section variant="card">
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
        <div style={{ height: 16 }} />
        <div className="card stack">
          <div style={{ fontWeight: 600 }}>Just need a simple queue?</div>
          <p className="muted" style={{ fontSize: 13 }}>
            If you already use Microsoft Bookings for appointments and only need queue management,
            we offer integration on request — <a href="mailto:hello@qbooker.example?subject=MS%20Bookings%20integration">get in touch</a> to discuss your setup.
          </p>
        </div>
      </Section>

      <Section>
        <SectionHeading title="Built to be trusted with your business" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 20 }}>
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
        <div className="card stack">
          <div style={{ fontWeight: 600 }}>Reliability</div>
          <p className="muted" style={{ fontSize: 13 }}>
            We take uptime seriously — this is where you'd state your specific commitment (e.g. a target
            percentage or response-time promise) once you've decided what you're comfortable guaranteeing.
          </p>
        </div>
      </Section>

      <Section id="faq" variant="card">
        <SectionHeading title="Questions" />
        <div className="stack" style={{ maxWidth: 640, margin: "0 auto" }}>
          <FaqItem q="Do I have to sign a contract?" a="No. You buy access for a day, week, month, or year at a time — nothing auto-renews, and there's no minimum term." />
          <FaqItem q="What if I only need a queue, not appointments?" a="Set any service to queue-only in a couple of clicks — or use hybrid mode to offer both walk-ins and bookings side by side." />
          <FaqItem q="Is there a limit on staff or services?" a="No — every plan includes unlimited staff, services, and appointments. You're only charged per location." />
          <FaqItem q="How long does setup actually take?" a="Most businesses are live in about 3 minutes — business name, a plan, your first location, and you're in. If you'd rather have it done for you, we offer paid setup assistance." />
        </div>
      </Section>

      <Section variant="navy">
        <div className="stack" style={{ textAlign: "center", gap: 14, padding: "12px 0" }}>
          <h2 style={{ fontSize: 22, margin: 0 }}>Ready to get started?</h2>
          <p className="muted" style={{ margin: 0 }}>Be live in about 3 minutes — no onboarding call required.</p>
          <div><button className="btn" onClick={onStart}>Get started</button></div>
        </div>
      </Section>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  const id = `faq-${q.length}-${q.slice(0, 8).replace(/\W/g, "")}`;
  return (
    <div className="card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="row"
        style={{ justifyContent: "space-between", width: "100%", background: "transparent", border: "none", padding: 0, textAlign: "left" }}
      >
        <strong style={{ fontSize: 14 }}>{q}</strong>
        <span className="muted" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <p id={id} className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>{a}</p>}
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
    <div className="stepper">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <span key={label} className="row" style={{ gap: 6 }}>
            <span className="row" style={{ gap: 6 }}>
              <span
                className="dot"
                style={{
                  background: active || done ? "var(--accent)" : "var(--line)",
                  color: active || done ? "#fff" : "var(--muted)",
                }}
              >
                {done ? "✓" : n}
              </span>
              <span className="step-label muted" style={{ color: active ? "var(--accent)" : undefined, fontWeight: active ? 600 : 400 }}>{label}</span>
            </span>
            {n < STEP_LABELS.length && <span className="seg" style={{ background: done ? "var(--accent)" : "var(--line)" }} />}
          </span>
        );
      })}
    </div>
  );
}

// Joins the 4 address parts into the single string the server stores, dropping any that are blank.
function combineAddress(line1, line2, city, postcode) {
  return [line1, line2, city, postcode].map((s) => (s || "").trim()).filter(Boolean).join(", ");
}

function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function AddressFields({ line1, line2, city, postcode, onChange }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="Address line 1">
        <input className="input" aria-label="Address line 1" value={line1} onChange={(e) => onChange("line1", e.target.value)} />
      </Field>
      <Field label="Address line 2">
        <input className="input" aria-label="Address line 2" value={line2} onChange={(e) => onChange("line2", e.target.value)} />
      </Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="City"><input className="input" aria-label="City" value={city} onChange={(e) => onChange("city", e.target.value)} /></Field>
        <Field label="Post / zip code"><input className="input" aria-label="Post / zip code" value={postcode} onChange={(e) => onChange("postcode", e.target.value)} /></Field>
      </div>
    </div>
  );
}

function PaymentOption({ active, onClick, title, desc }) {
  return (
    <label className={active ? "pay-option active" : "pay-option"} onClick={onClick}>
      <input type="radio" checked={active} onChange={onClick} />
      <span>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12 }}>{desc}</div>
      </span>
    </label>
  );
}

function Signup({ onDone, setError, onBackToLanding }) {
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
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [step]);

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
    <div className="narrow stack" style={{ paddingTop: 32, paddingBottom: 48 }}>
      <div className="stack" style={{ gap: 4, textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>Set up your account</h2>
        <button
          type="button"
          onClick={onBackToLanding}
          className="muted"
          style={{ background: "transparent", border: "none", fontSize: 12, padding: 0, cursor: "pointer", textDecoration: "underline" }}
        >
          ← Back to overview
        </button>
      </div>
      <StepHeader step={step} />

      <div className="card stack" style={{ padding: 24 }}>
        {step === 1 && (
          <div className="stack">
            <div className="stack" style={{ gap: 2, marginBottom: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Your details</div>
              <div className="muted" style={{ fontSize: 12 }}>Who's setting this account up, and how we'll reach you.</div>
            </div>
            <Field label="Business name">
              <input className="input" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <Field label="First name"><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
              <Field label="Last name"><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
            </div>
            <Field label="Email address" hint="This is what you'll sign in with — we'll send a one-time code here each time, no password to remember.">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>

            <div style={{ borderTop: "1px solid var(--line)", margin: "12px 0" }} />

            <div className="stack" style={{ gap: 2, marginBottom: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Company address <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></div>
            </div>
            <AddressFields
              line1={companyLine1} line2={companyLine2} city={companyCity} postcode={companyPostcode}
              onChange={(field, value) => {
                if (field === "line1") setCompanyLine1(value);
                if (field === "line2") setCompanyLine2(value);
                if (field === "city") setCompanyCity(value);
                if (field === "postcode") setCompanyPostcode(value);
              }}
            />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" disabled={!step1Valid} onClick={next}>Continue</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <div className="stack" style={{ gap: 2, marginBottom: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Choose your access period</div>
              <div className="muted" style={{ fontSize: 12 }}>
                You're not choosing a start date — access begins automatically the moment you set opening hours for
                your first service, whenever you're actually ready. Nothing is wasted while you're still setting up.
              </div>
            </div>
            <div className="wrap">
              {PLAN_META.map((p) => (
                <button key={p.id} className={planId === p.id ? "btn" : "btn-outline"} onClick={() => setPlanId(p.id)}>{p.label}</button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{selectedPlan?.desc}</div>
            {planId === "custom" && (
              <div className="row"><span className="muted">Days:</span><input className="input" type="number" min={1} value={customDays} onChange={(e) => setCustomDays(Number(e.target.value))} /></div>
            )}

            <div style={{ borderTop: "1px solid var(--line)", margin: "12px 0" }} />

            <div className="stack" style={{ gap: 2, marginBottom: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Add your locations</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Name each location now — each name must be unique. Once you're in, you'll just need to add services,
                set working hours, and pick the dates you're open.
              </div>
            </div>
            <div className="stack">
              {locationNames.map((name, i) => (
                <div key={i} className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    aria-label={`Location ${i + 1} name`}
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
              <div style={{ fontSize: 12, color: "var(--error)", fontWeight: 500 }}>
                Each location needs its own name — two locations currently share the same name.
              </div>
            )}

            <div className="card row" style={{ justifyContent: "space-between", alignItems: "center", background: "var(--accent-weak)" }}>
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
            <div className="stack" style={{ gap: 2, marginBottom: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>How would you like to pay?</div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <PaymentOption
                active={paymentMethod === "card"}
                onClick={() => setPaymentMethod("card")}
                title="Card"
                desc="Card payment via Stripe is coming soon — for now your account is activated immediately without a real charge."
              />
              <PaymentOption
                active={paymentMethod === "invoice"}
                onClick={() => setPaymentMethod("invoice")}
                title="Invoice"
                desc="Your account can be fully configured straight away, but staff kiosk and customer WhatsApp won't be enabled until payment is received."
              />
            </div>
            {paymentMethod === "invoice" && (
              <div className="stack">
                <Field label="Billing email">
                  <input className="input" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
                </Field>
                <Field label="PO / reference number" hint="Required for invoice payment — your internal purchase order or reference number.">
                  <input className="input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
                </Field>
              </div>
            )}

            <div className="card row" style={{ justifyContent: "space-between", alignItems: "center", background: "var(--accent-weak)" }}>
              <span className="muted" style={{ fontSize: 12 }}>£{perLocation} × {locationCount} location{locationCount === 1 ? "" : "s"}</span>
              <span>Total: <strong>£{total}</strong>{salePrice != null && <span className="muted" style={{ fontSize: 12 }}> (sale price applied)</span>}</span>
            </div>

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn-outline" onClick={back}>Back</button>
              <button className="btn" disabled={submitting || !step3Valid} onClick={submit}>{submitting ? "Processing…" : "Create account"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
