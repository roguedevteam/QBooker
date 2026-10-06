import { useState, useEffect } from "react";
import { priceText, exMoney, incVat } from "./lib/vat.js";
import { api } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";

const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || "http://localhost:5173";

const PLAN_META = [
  { id: "day", label: "Day", days: 1, desc: "One day of access, until midnight." },
  { id: "week", label: "Week", days: 7, desc: "Seven days of access." },
  { id: "month", label: "Month", days: 30, desc: "30 days of access." },
  { id: "year", label: "Year", days: 365, desc: "365 days of access — best value for ongoing use." },
  { id: "custom", label: "Custom", days: null, desc: "Choose exactly how many days you need." },
];

const SERVICE_MODE_META = [
  { id: "queue", label: "Queue — walk-ins only" },
  { id: "appointment", label: "Appointments — booked slots only" },
  { id: "hybrid", label: "Hybrid — walk-ins and bookings" },
];

function servicePlanPrice(svc, pricing) {
  if (svc.planId === "custom") return (Number(svc.customDays) || 1) * pricing.customDailyRate;
  const onSale = pricing.sale?.active && pricing.sale[svc.planId] != null;
  return onSale ? pricing.sale[svc.planId] : pricing[svc.planId];
}

// Shared logo mark — a steel-blue tile with an amber "notch", plus the wordmark.
// `dark` switches the wordmark to a light colour for use on the navy band / header.
function Logo({ size = 28, dark = false, withWord = true }) {
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
      {inCheckout && (
        <div className="header row" style={{ justifyContent: "space-between" }}>
          <a href="#top" onClick={() => setScreen("landing")} style={{ textDecoration: "none" }}>
            <Logo />
          </a>
          <div className="row">
            {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
            <a href={ADMIN_APP_URL} style={{ color: "var(--muted)", fontSize: 13, fontWeight: 600 }}>Already have an account? Sign in →</a>
          </div>
        </div>
      )}
      {error && <div className="container"><div className="card" style={{ borderColor: "#B3261E", color: "#B3261E" }}>{error} <button className="btn-outline" style={{ marginLeft: 8 }} onClick={() => setError("")}>Dismiss</button></div></div>}

      {screen === "landing" && (
        <Landing
          onStart={() => setScreen("signup")}
          simulatedBadge={isSimulatedToday() ? todayIso() : null}
        />
      )}
      {screen === "signup" && <Signup setError={setError} onDone={(r) => { setResult(r); setScreen("success"); }} onBackToLanding={() => setScreen("landing")} />}
      {screen === "success" && result && <Success result={result} />}
    </div>
  );
}

const SCENARIOS = [
  { name: "Blood clinics", text: "A morning of walk-in blood tests without a waiting room full of paper tickets." },
  { name: "Diagnostic days", text: "Scans and tests that run on set days, with patients arriving throughout the day." },
  { name: "Vaccination pop-ups", text: "A flu or travel clinic in a community hall for a week, then gone again." },
  { name: "Outpatient clinics", text: "Specialist sessions that only open on certain days of the month." },
];

const PATIENT_ACTIONS = [
  { name: "Join the queue", text: "Patients message your WhatsApp number and get a ticket, their place in line and an estimated wait." },
  { name: "Book a slot", text: "Pick a time later in the day and get a reminder shortly beforehand." },
  { name: "Check in", text: "Let your team know they've arrived, without queuing at a desk." },
  { name: "Cancel or reschedule", text: "One reply, no phone call. Easy enough that people actually do it." },
];

const MODES = [
  { name: "Queue management", text: "The core of QBooker. Patients join the live queue from WhatsApp and your team calls the next ticket from any browser." },
  { name: "Appointment scheduling", text: "Add timed slots when you need them. Patients book, get a reminder, and can cancel with a reply." },
  { name: "Hybrid queue", text: "Both in one service. Walk-ins join now while others reserve a place later in the day.", highlight: true },
];

const SETUP_STEPS = [
  { name: "Create your account", text: "Your name, your business name and your email address." },
  { name: "Add your service", text: "Name it, choose queue, appointments or hybrid, and pick your two free days." },
  { name: "Share your WhatsApp link", text: "Patients can start queuing straight away." },
];

const TRUST_POINTS = [
  { name: "No patient data", text: "Patient data and clinical records are never captured or stored." },
  { name: "GDPR", text: "Fully compliant with GDPR." },
  { name: "Cyber Essentials", text: "Compliant with the Cyber Essentials standard." },
  { name: "UK servers and support", text: "Your data stays in the UK, and when you need help you talk to someone in the same time zone." },
];

const FAQS = [
  { q: "Do patients need to install anything?", a: "No. Everything happens inside WhatsApp, which almost everyone already has." },
  { q: "Is it safe to use in an NHS setting?", a: "QBooker doesn't capture or store patient data or clinical records. It's GDPR and Cyber Essentials compliant, with UK-based servers and a UK-based support team." },
  { q: "Can I use it for just one day?", a: "Yes. Licences are bought per service and can run for a day, a week, a month or any custom number of days, so a one-off clinic day costs a one-day licence." },
  { q: "What's the difference between queue, appointments and hybrid?", a: "A queue is walk-ins only, first come first served. Appointments are booked slots only. Hybrid runs both together in one service, so people on site can join the queue now while others reserve a slot for later." },
  { q: "What if a patient doesn't use WhatsApp?", a: "They can still turn up as normal and your team adds them to the same queue by hand." },
  { q: "Can I run more than one location?", a: "Yes. Each location gets its own sign-in code and queue, and staff only see their own." },
  { q: "How long does setup take?", a: "Under 60 seconds to create an account and add a service, and no training is needed. If you'd like help anyway, an engineer can join a one-hour call to set up your system and train your team for £125 ex VAT (£150 inc VAT)." },
  { q: "Is there a contract?", a: "No long-term contract. Buy a licence for a day, week, month or custom period at a time. Annual licences are available on request." },
];

// Hybrid timeline — a one-day clinic from 9am to 5pm. Positions are percentages of that span.
const TL_TICKS = [
  { t: 0, label: "9am" },
  { t: 37.5, label: "12pm" },
  { t: 75, label: "3pm" },
  { t: 100, label: "5pm" },
];
const TL_NOW = 20.8; // 10:40am
const TL_WALKINS = [
  { at: 27, label: "#14" },
  { at: 40, label: "#15" },
  { at: 53, label: "#16" },
];
const TL_BOOKED = [
  { at: 62.5, label: "2pm" },
  { at: 75, label: "3pm" },
  { at: 87.5, label: "4pm", mine: true },
];

function HybridTimeline() {
  return (
    <div className="lp-timeline-card" role="img" aria-label="A one-day clinic from 9am to 5pm. At 10:40am, patients on site join the queue as tickets 14, 15 and 16. Patients at work have reserved slots at 2pm, 3pm and 4pm. Both appear in the same queue.">
      <div className="lp-tl" aria-hidden="true">
        <div />
        <div className="lp-tl-axis">
          {TL_TICKS.map((k) => (
            <span key={k.label} className="lp-tl-tick" style={{ left: `${k.t}%`, transform: k.t === 0 ? "none" : k.t === 100 ? "translateX(-100%)" : "translateX(-50%)" }}>{k.label}</span>
          ))}
          <span className="lp-tl-nowlabel" style={{ left: `${TL_NOW}%` }}>Now 10:40</span>
        </div>

        <div className="lp-tl-lane"><strong>On site</strong><span>Joins the queue now</span></div>
        <div className="lp-track">
          <span className="lp-now" style={{ left: `${TL_NOW}%` }} />
          {TL_WALKINS.map((c) => <span key={c.label} className="lp-chip walk" style={{ left: `${c.at}%` }}>{c.label}</span>)}
        </div>

        <div className="lp-tl-lane"><strong>At work</strong><span>Reserves a slot for later</span></div>
        <div className="lp-track">
          <span className="lp-now" style={{ left: `${TL_NOW}%` }} />
          {TL_BOOKED.map((c) => <span key={c.label} className={c.mine ? "lp-chip book mine" : "lp-chip book"} style={{ left: `${c.at}%` }}>{c.label}</span>)}
        </div>
      </div>
      <div className="lp-tl-caption">
        <span><i className="lp-key walk" /> Walk-in, served in order</span>
        <span><i className="lp-key book" /> Reserved slot</span>
      </div>
    </div>
  );
}

function Landing({ onStart, simulatedBadge }) {
  const [pricing, setPricing] = useState(null);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  return (
    <div id="top" className="lp">
      <div className="lp-promo">
        <div className="wide"><strong>Two free days</strong> <span>No card needed</span> <span>Try us out</span></div>
      </div>
      {/* NAV */}
      <header className="lp-nav">
        <div className="wide lp-nav-inner">
          <a href="#top" aria-label="QBooker home"><Logo /></a>
          <nav className="lp-nav-links" aria-label="Page sections">
            <a href="#who">Use cases</a>
            <a href="#hybrid">Hybrid queue</a>
            <a href="#trust">Compliance</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="row" style={{ gap: 18 }}>
            {simulatedBadge && <span className="badge badge-amber">Simulated date: {simulatedBadge}</span>}
            <a href={ADMIN_APP_URL} className="lp-login">Log in</a>
            <button className="btn-ink" style={{ padding: "10px 18px", fontSize: 14 }} onClick={onStart}>Start free trial</button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="wide lp-hero">
        <div>
          <h1 className="lp-h1">A WhatsApp queue for your clinic, live in under 60 seconds</h1>
          <p className="lp-lead">QBooker is queue management for NHS and healthcare services that don't run every day. Patients join from WhatsApp, your team calls them forward, and there's no hardware to buy or install.</p>
          <div className="lp-actions">
            <button className="btn-accent" onClick={onStart}>Start free trial</button>
            <a href="#hybrid" className="lp-link">See how the hybrid queue works</a>
          </div>
          <ul className="lp-checks">
            <li>Two free days to try it, with no card needed</li>
            <li>No patient data or clinical records stored</li>
            <li>UK-based servers and support</li>
          </ul>
        </div>

        <div className="lp-hero-visual">
          <div className="lp-chat" role="img" aria-label="Example WhatsApp conversation: a patient joins the blood tests queue and is told they are third in line, about 15 minutes.">
            <div className="lp-chat-head" aria-hidden="true">
              <span className="lp-avatar">R</span>
              <div><strong>Riverside Blood Clinic</strong><span>Business account</span></div>
            </div>
            <div className="lp-chat-body" aria-hidden="true">
              <div className="msg in">Welcome to Riverside Blood Clinic. Reply Hi to get a ticket or book a slot.</div>
              <div className="msg out">Hi</div>
              <div className="msg in">Which service would you like today?</div>
              <div className="msg out">Blood tests</div>
              <div className="msg in">You're checked in. Your ticket is BT-014. You're #3 in line, about 15 min.</div>
            </div>
          </div>
          <div className="lp-ticket" aria-hidden="true">
            <div className="lp-ticket-top">
              <span>Blood tests, Room 2</span>
              <span className="lp-live">Live</span>
            </div>
            <div className="lp-ticket-main">
              <span className="muted">Now serving</span>
              <span className="mono lp-ticket-no">BT-011</span>
            </div>
            <div className="lp-ticket-divider" />
            <div className="lp-ticket-next">
              <span className="mono">BT-012</span><span className="mono">BT-013</span><span className="mono">BT-014</span>
            </div>
          </div>
        </div>
      </section>

      {/* FACTS */}
      <section className="lp-band-navy lp-facts-band">
        <div className="wide lp-facts">
          <div><strong>Live in under 60 seconds</strong><p>Create an account, add a service and your queue is ready.</p></div>
          <div><strong>No hardware</strong><p>No kiosks, ticket printers or installation. Your team uses a web page.</p></div>
          <div><strong>No patient data stored</strong><p>QBooker doesn't capture patient records of any kind.</p></div>
          <div><strong>UK-based support</strong><p>UK servers and a UK support team.</p></div>
        </div>
      </section>

      {/* WHO IT'S FOR */}
      <section id="who" className="lp-section">
        <div className="wide lp-split">
          <div>
            <h2 className="lp-h2">Built for clinics that don't open every day</h2>
            <p className="lp-lead">Most queue systems assume a permanent front desk and equipment to match. QBooker is set up per service, for exactly as long as you need it. Running a clinic for one day? Set it up for that one day and that one service, then let it lapse.</p>
          </div>
          <div className="lp-rows">
            {SCENARIOS.map((s) => (
              <div key={s.name} className="lp-row">
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PATIENTS */}
      <section id="patients" className="lp-section lp-band-card">
        <div className="wide lp-split">
          <div>
            <h2 className="lp-h2">If cancelling is hard, patients just don't turn up</h2>
            <p className="lp-lead">QBooker keeps patients in touch over WhatsApp, so changing their mind takes one reply. You hear about it before the slot goes empty, and the slot can go to someone else.</p>
          </div>
          <div className="lp-rows">
            {PATIENT_ACTIONS.map((s) => (
              <div key={s.name} className="lp-row">
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MODES */}
      <section id="modes" className="lp-section">
        <div className="wide">
          <h2 className="lp-h2">Queue management first, appointments when you need them</h2>
          <p className="lp-lead" style={{ marginBottom: 40 }}>Each service runs in one of three modes. You choose per service, and it can differ from one clinic day to the next.</p>
          <div className="lp-modes">
            {MODES.map((m) => (
              <div key={m.name} className={m.highlight ? "lp-mode hl" : "lp-mode"}>
                <h3>{m.name}</h3>
                <p>{m.text}</p>
                {m.highlight && <a href="#hybrid" className="lp-link">See how it works</a>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HYBRID */}
      <section id="hybrid" className="lp-section lp-band-navy">
        <div className="wide lp-split lp-split-even">
          <div>
            <h2 className="lp-h2">One queue for people on site and people at work</h2>
            <p className="lp-lead">Set up a one-day clinic as a hybrid service and patients can join in two ways. Someone already on site joins the queue right now. Someone at work books a 4pm slot from their desk, which holds their place for later in the day.</p>
            <p className="lp-lead" style={{ marginTop: 18 }}>Your team sees one queue with one WhatsApp number. You decide how many staff serve walk-ins and how many serve bookings, so neither side crowds out the other.</p>
          </div>
          <HybridTimeline />
        </div>
      </section>

      {/* SETUP */}
      <section id="setup" className="lp-section">
        <div className="wide">
          <h2 className="lp-h2">Live in under 60 seconds, with nothing to learn</h2>
          <p className="lp-lead" style={{ marginBottom: 40 }}>QBooker is built so nobody needs training. Create an account, add a service and you're ready to go, with two free days and no card.</p>
          <div className="lp-steps">
            {SETUP_STEPS.map((s, i) => (
              <div key={s.name} className="lp-step">
                <span className="lp-step-no">{i + 1}</span>
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
          <div className="lp-support">
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Want someone to walk you through it?</div>
              <p className="muted" style={{ fontSize: 14.5, margin: "4px 0 0", maxWidth: 520 }}>An engineer can join a one-hour call to set up your system and train your team.</p>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <strong style={{ fontSize: 18 }}>£125 ex VAT (£150 inc VAT)</strong>
              <a href="mailto:hello@qbooker.example?subject=Setup%20assistance"><button className="btn-outline">Book a call</button></a>
            </div>
          </div>
        </div>
      </section>

      {/* COMPLIANCE */}
      <section id="trust" className="lp-section lp-band-card">
        <div className="wide lp-split">
          <div>
            <h2 className="lp-h2">No patient data, and UK-based</h2>
            <p className="lp-lead">QBooker doesn't capture or store patient data or clinical records, which keeps information governance straightforward.</p>
          </div>
          <div className="lp-rows">
            {TRUST_POINTS.map((s) => (
              <div key={s.name} className="lp-row">
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="lp-section">
        <div className="wide">
          <h2 className="lp-h2">Two free days, then pay per service</h2>
          <p className="lp-lead" style={{ marginBottom: 40 }}>Test it on a real clinic day before you spend anything.</p>
          <div className="lp-pricing">
            <div className="lp-offer">
              <h3>Two free days for every new account</h3>
              <p>Sign up and try QBooker on a real clinic day. No card needed and nothing to cancel, so you can see how patients get on before you spend anything.</p>
              <button className="btn-accent" onClick={onStart}>Start free trial</button>
            </div>
            <div>
              <p style={{ margin: "0 0 16px", fontSize: 16, lineHeight: 1.55, maxWidth: 520 }}>After that, each service has its own licence for a day, a week, a month or a custom number of days.</p>
              {pricing && (
                <>
                  {pricing.sale?.active && <p style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, margin: "0 0 10px" }}>Sale on selected plans</p>}
                  <div className="lp-prices">
                    {["day", "week", "month"].map((k) => {
                      const label = { day: "Day", week: "Week", month: "Month" }[k];
                      const onSale = pricing.sale?.active && pricing.sale[k] != null;
                      return (
                        <div key={k} className="lp-price">
                          {onSale && <span className="muted" style={{ fontSize: 13, textDecoration: "line-through" }}>{exMoney(pricing[k])}</span>}
                          <strong style={{ color: onSale ? "var(--accent)" : undefined }}>{exMoney(onSale ? pricing.sale[k] : pricing[k])}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>ex VAT ({exMoney(incVat(onSale ? pricing.sale[k] : pricing[k]))} inc VAT)</span>
                          <span className="muted">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>All prices are per service. Need something in between? Choose a custom number of days. Want a full year? Annual licences are priced on application, so <a href="mailto:hello@qbooker.example?subject=Annual%20licence" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>contact us</a>.</p>
                </>
              )}
              <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 28, maxWidth: 520 }}>
                Already use Microsoft Bookings for appointments and only need queue management? We offer integration on request.{" "}
                <a href="mailto:hello@qbooker.example?subject=MS%20Bookings%20integration" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Get in touch</a> to discuss your setup.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="lp-section lp-band-card">
        <div className="wide lp-faq-split">
          <div>
            <h2 className="lp-h2">Questions people ask before switching</h2>
            <p className="lp-lead">Something else? <a href="mailto:hello@qbooker.example" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Email our UK support team</a>.</p>
          </div>
          <div>
            {FAQS.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="lp-band-navy lp-cta-band">
        <div className="wide lp-cta">
          <div>
            <h2 className="lp-h2" style={{ marginBottom: 10 }}>Ready to run your next clinic day without the paperwork?</h2>
            <p className="lp-lead">Two free days. No card needed.</p>
          </div>
          <button className="btn-accent" onClick={onStart}>Start free trial</button>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="wide lp-footer-grid">
          <div>
            <Logo size={22} />
            <p className="muted" style={{ fontSize: 14, maxWidth: 280, lineHeight: 1.6, marginTop: 12 }}>Queue management over WhatsApp for NHS and healthcare services.</p>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <strong style={{ fontSize: 13 }}>Product</strong>
            <a href="#patients" className="muted">For patients</a>
            <a href="#hybrid" className="muted">Hybrid queue</a>
            <a href="#pricing" className="muted">Pricing</a>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <strong style={{ fontSize: 13 }}>Use cases</strong>
            <a href="#who" className="muted">Blood clinics</a>
            <a href="#who" className="muted">Diagnostic days</a>
            <a href="#who" className="muted">Vaccination pop-ups</a>
            <a href="#who" className="muted">Outpatient clinics</a>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <strong style={{ fontSize: 13 }}>Company</strong>
            <a href="#trust" className="muted">Compliance</a>
            <a href="mailto:hello@qbooker.example" className="muted">Support</a>
            <a href={ADMIN_APP_URL} className="muted">Log in</a>
          </div>
        </div>
        <div className="wide lp-footer-base">© QBooker</div>
      </footer>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  const id = `faq-${q.length}-${q.slice(0, 8).replace(/\W/g, "")}`;
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="row"
        style={{ justifyContent: "space-between", width: "100%", background: "transparent", border: "none", padding: "18px 4px", textAlign: "left", fontFamily: "inherit", fontSize: 15, fontWeight: 600, cursor: "pointer", color: "var(--ink)" }}
      >
        <span>{q}</span>
        <span className="muted" style={{ fontSize: 18 }} aria-hidden="true">{open ? "–" : "+"}</span>
      </button>
      {open && <p id={id} className="muted" style={{ fontSize: 14, lineHeight: 1.6, padding: "0 4px 18px", margin: 0 }}>{a}</p>}
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

const STEP_LABELS = ["Your details", "Locations", "Services", "Payment"];
const STEP_LABELS_FREE = ["Your details", "Locations", "Services"];

function StepHeader({ step, labels }) {
  const stepLabels = labels || STEP_LABELS;
  return (
    <div className="stepper">
      {stepLabels.map((label, i) => {
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
            {n < stepLabels.length && <span className="seg" style={{ background: done ? "var(--accent)" : "var(--line)" }} />}
          </span>
        );
      })}
    </div>
  );
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

function ServiceRow({ svc, index, locationNames, pricing, onChange, onRemove, removable }) {
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Service {index + 1}</span>
        {removable && (
          <button type="button" className="loc-remove" style={{ width: "auto", padding: "2px 8px" }} onClick={onRemove} aria-label={`Remove service ${index + 1}`}>✕</button>
        )}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Field label="Service name">
          <input className="input" placeholder="e.g. Blood Test" value={svc.name} onChange={(e) => onChange({ ...svc, name: e.target.value })} />
        </Field>
        <Field label="Location">
          <select className="input" value={svc.locationIndex} onChange={(e) => onChange({ ...svc, locationIndex: Number(e.target.value) })}>
            {locationNames.map((n, i) => <option key={i} value={i}>{n.trim() || `Location ${i + 1}`}</option>)}
          </select>
        </Field>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Field label="How does this work?">
          <select className="input" value={svc.mode} onChange={(e) => onChange({ ...svc, mode: e.target.value })}>
            {SERVICE_MODE_META.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        {svc.mode !== "queue" && (
          <Field label="Slot length">
            <select className="input" value={svc.slotMinutes} onChange={(e) => onChange({ ...svc, slotMinutes: Number(e.target.value) })}>
              {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>Can't be changed after signup — delete and recreate the service in your admin dashboard if you need to change it later.</div>
    </div>
  );
}

function Signup({ onDone, setError, onBackToLanding }) {
  const [step, setStep] = useState(1);

  // Step 1 — contact & business details
  const [businessName, setBusinessName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");

  // Step 2 — locations (free, unlimited — just a routing/staff-access concept)
  const [locationNames, setLocationNames] = useState([""]);
  const MAX_LOCATIONS = 20;

  // Step 3 — services, each assigned to a location and bought with its own license.
  // Shown one at a time (activeService) so a long list doesn't turn into one giant scroll.
  const [services, setServices] = useState([{ name: "", locationIndex: 0, mode: "queue", slotMinutes: 15, planId: "month", customDays: 14 }]);
  const [activeService, setActiveService] = useState(0);
  const MAX_SERVICES = 30;

  // Step 4 — payment
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
    setServices((prev) => prev.map((s) => (s.locationIndex === i ? { ...s, locationIndex: 0 } : s.locationIndex > i ? { ...s, locationIndex: s.locationIndex - 1 } : s)));
  }
  function updateLocationName(i, value) {
    setLocationNames((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }

  function addService() {
    if (services.length >= MAX_SERVICES) return;
    const next = [...services, { name: "", locationIndex: 0, mode: "queue", slotMinutes: 15, planId: "month", customDays: 14 }];
    setServices(next);
    setActiveService(next.length - 1);
  }
  function removeService(i) {
    if (services.length <= 1) return;
    const next = services.filter((_, idx) => idx !== i);
    setServices(next);
    setActiveService((cur) => Math.min(cur, next.length - 1));
  }
  function updateService(i, next) {
    setServices((prev) => prev.map((s, idx) => (idx === i ? next : s)));
  }

  const total = services.reduce((sum, s) => sum + (Number(servicePlanPrice(s, pricing)) || 0), 0).toFixed(2);
  // Every new account starts on a free 2-day trial — no payment step at signup.
  const needsPayment = false;
  const stepLabels = needsPayment ? STEP_LABELS : STEP_LABELS_FREE;
  const lastStep = stepLabels.length;
  // If editing services back on step 3 drops the total to free (or raises it back above
  // free) while already past where the payment step would be, keep the step in range.
  useEffect(() => { setStep((s) => Math.min(s, lastStep)); }, [lastStep]);

  const step1Valid = businessName.trim() && firstName.trim() && lastName.trim() && email.trim();
  const activeNames = locationNames.map((n) => n.trim());
  const namesFilled = activeNames.every((n) => n);
  const normalizedNames = activeNames.map((n) => n.toLowerCase());
  const hasDuplicateNames = namesFilled && new Set(normalizedNames).size !== normalizedNames.length;
  const step2Valid = namesFilled && !hasDuplicateNames;
  const isServiceValid = (s) => s.name.trim() && s.planId && (s.planId !== "custom" || Number(s.customDays) > 0);
  const step3Valid = services.every(isServiceValid);
  const step4Valid = paymentMethod === "card" || paymentMethod === "later" || (invoiceEmail.trim() && poNumber.trim());

  function next() { setStep((s) => Math.min(lastStep, s + 1)); }
  function back() { setStep((s) => Math.max(1, s - 1)); }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      // Nothing to charge — every service's license came out free (e.g. a sale or £0
      // pricing), so there's no payment method to collect; bill as "card" with no
      // invoice fields since there's nothing to invoice either.
      const payload = {
        businessName, firstName, lastName, email,
        locations: locationNames.map((n) => ({ name: n.trim() })),
        services: services.map((s) => ({
          name: s.name.trim(), locationIndex: s.locationIndex, mode: s.mode, slotMinutes: s.slotMinutes,
        })),
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
      <StepHeader step={step} labels={stepLabels} />

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
            <div className="muted" style={{ fontSize: 12 }}>
              You can add your business address later from the Profile tab once you're set up.
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" disabled={!step1Valid} onClick={next}>Continue</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="stack" style={{ gap: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Add your locations</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Locations are free and unlimited — they're just how customers and staff get routed to the right place.
                Name each one now; each name must be unique. You'll pick services and licenses next.
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {locationNames.map((name, i) => (
                <div key={i} className="loc-row">
                  <span className="loc-index">{i + 1}</span>
                  <input
                    className="input"
                    aria-label={`Location ${i + 1} name`}
                    placeholder={`Location ${i + 1} name`}
                    value={name}
                    onChange={(e) => updateLocationName(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className="loc-remove"
                    onClick={() => removeLocation(i)}
                    disabled={locationNames.length <= 1}
                    aria-label={`Remove location ${i + 1}`}
                    title={locationNames.length <= 1 ? "At least one location is required" : "Remove this location"}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="loc-add" onClick={addLocation} disabled={locationNames.length >= MAX_LOCATIONS}>+ Add another location</button>
            </div>
            {hasDuplicateNames && (
              <div style={{ fontSize: 12, color: "var(--error)", fontWeight: 500 }}>
                Each location needs its own name — two locations currently share the same name.
              </div>
            )}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn-outline" onClick={back}>Back</button>
              <button className="btn" disabled={!step2Valid} onClick={next}>Continue</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack" style={{ gap: 16 }}>
            <div className="stack" style={{ gap: 2 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Add your services</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Each service belongs to one location. Your 2 free days go on the first service you add, and you choose
                which two days from its calendar once you're in, so nothing is wasted while you're still setting up.
              </div>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              {services.length > 1 && (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <button type="button" className="btn-outline" disabled={activeService === 0} onClick={() => setActiveService((i) => Math.max(0, i - 1))}>← Previous</button>
                  <div className="row" style={{ gap: 6 }}>
                    {services.map((s, i) => (
                      <button
                        type="button"
                        key={i}
                        onClick={() => setActiveService(i)}
                        title={`Service ${i + 1}${s.name.trim() ? `: ${s.name.trim()}` : ""}`}
                        style={{
                          width: 9, height: 9, padding: 0, borderRadius: "50%", cursor: "pointer",
                          border: i === activeService ? "2px solid var(--accent)" : "none",
                          background: isServiceValid(s) ? "var(--accent)" : "var(--line)",
                        }}
                      />
                    ))}
                  </div>
                  <button type="button" className="btn-outline" disabled={activeService === services.length - 1} onClick={() => setActiveService((i) => Math.min(services.length - 1, i + 1))}>Next →</button>
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, textAlign: "center" }}>Service {activeService + 1} of {services.length}</div>
              <ServiceRow
                key={activeService}
                svc={services[activeService]}
                index={activeService}
                locationNames={locationNames}
                pricing={pricing}
                onChange={(next) => updateService(activeService, next)}
                onRemove={() => removeService(activeService)}
                removable={services.length > 1}
              />
              <button type="button" className="loc-add" onClick={addService} disabled={services.length >= MAX_SERVICES}>+ Add another service</button>
            </div>

            <div className="card row" style={{ justifyContent: "space-between", alignItems: "center", background: "var(--accent-weak)" }}>
              <span style={{ fontSize: 13 }}><strong>2 free days</strong> — no card needed. Add more licences whenever you're ready.</span>
            </div>

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn-outline" onClick={back}>Back</button>
              {needsPayment ? (
                <button className="btn" disabled={!step3Valid} onClick={next}>Continue</button>
              ) : (
                <button className="btn" disabled={!step3Valid || submitting} onClick={submit}>{submitting ? "Processing…" : "Create account"}</button>
              )}
            </div>
          </div>
        )}

        {step === 4 && needsPayment && (
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
              <PaymentOption
                active={paymentMethod === "later"}
                onClick={() => setPaymentMethod("later")}
                title="Pay later"
                desc="Get set up and explore the system now — staff kiosk and customer WhatsApp switch on once we've sorted payment with you."
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
              <span className="muted" style={{ fontSize: 12 }}>{services.length} service license{services.length === 1 ? "" : "s"}</span>
              <span>Total: <strong>{priceText(total)}</strong></span>
            </div>

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn-outline" onClick={back}>Back</button>
              <button className="btn" disabled={submitting || !step4Valid} onClick={submit}>{submitting ? "Processing…" : "Create account"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
