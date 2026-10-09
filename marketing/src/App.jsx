import { useState, useEffect, useRef, useId, cloneElement } from "react";
import CodeBoxes from "./CodeBoxes.jsx";
import { priceText, exMoney, incVat } from "./lib/vat.js";
import { api } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock } from "./lib/clock.js";
import { mailto } from "./lib/config.js";
import Privacy from "./Privacy.jsx";
import NHSBuyers from "./NHSBuyers.jsx";

// --- Public claims: flip these once the underlying fact is verified ---------------------------
// Nothing here can be checked from the code, so the safe wording is the default.
//  cyberEssentials      true ONLY once a Cyber Essentials certificate is held (add the number/date to CE_CLAIM below).
//  ukServersAndSupport  true ONLY once the hosting regions (database, API, static hosting) are confirmed to be in the UK
//                       and support is genuinely UK-based. false hides every "UK-based" statement on the site.
const CERTIFICATIONS = {
  cyberEssentials: false,
  ukServersAndSupport: true, // TO CONFIRM before launch: Supabase, Railway and Render regions.
};
const CE_CLAIM = CERTIFICATIONS.cyberEssentials
  ? "Cyber Essentials certified."
  : "Built to Cyber Essentials-aligned practices (certification to be confirmed).";
const UK = CERTIFICATIONS.ukServersAndSupport;

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
        <rect x="2" y="2" width="40" height="40" fill="var(--accent)" />
        <circle cx="42" cy="22" r="7" fill="var(--blue)" />
      </svg>
      {withWord && <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>}
    </span>
  );
}

function MarketingApp() {
  const [screen, setScreen] = useState("landing");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { tenant, demoOtp } after a successful signup
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="container muted" role="status" style={{ textAlign: "center", paddingTop: 60 }}>Loading…</div>;

  const inCheckout = screen === "signup" || screen === "success";

  return (
    <div>
      {inCheckout && (
        <>
          <header className="su-header">
            <div className="su-header-in">
              <a href="#top" onClick={() => setScreen("landing")} className="su-logo-link" aria-label="QBooker home">
                <Logo />
              </a>
              <a href={ADMIN_APP_URL} className="su-signin"><span className="su-long">Already have an account? </span>Sign in →</a>
            </div>
          </header>
          {isSimulatedToday() && <div className="su-sim" role="status">Simulated date: {todayIso()}</div>}
        </>
      )}
      {error && (
        <div className="su-wrap" style={{ paddingBottom: 0 }}>
          <div className="su-alert" role="alert">
            <span>{error}</span>
            <button type="button" className="su-btn su-btn-outline" onClick={() => setError("")}>Dismiss</button>
          </div>
        </div>
      )}

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


// Tiny path router (Render rewrites every path to index.html). "/" is the site, "/privacy" the notice,
// anything else gets a friendly not-found page rather than the landing page under a wrong URL.
function NotFound() {
  useEffect(() => {
    document.title = "Page not found — QBooker";
    const m = document.createElement("meta");
    m.name = "robots"; m.content = "noindex";
    document.head.appendChild(m);
    return () => m.remove();
  }, []);
  return (
    <main id="main" className="pv pv-nf">
      <h1>Page not found</h1>
      <p className="pv-lead" style={{ margin: "0 auto 20px" }}>We couldn't find that page.</p>
      <a href="/" className="pv-back" style={{ textDecoration: "underline" }}>Go to the QBooker home page</a>
    </main>
  );
}

export default function App() {
  const path = (window.location.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  if (path === "/privacy") return <Privacy />;
  if (path === "/nhs-buyers") return <NHSBuyers />;
  if (path === "/" || path === "/index.html") return <MarketingApp />;
  return <NotFound />;
}

const SCENARIOS = [
  { name: "Blood clinics", text: "A morning of walk-in blood tests without a waiting room full of paper tickets." },
  { name: "Diagnostic days", text: "Scans and tests that run on set days, with patients arriving throughout the day." },
  { name: "Vaccination pop-ups", text: "A flu or travel clinic in a community hall for a week, then gone again." },
  { name: "Outpatient clinics", text: "Specialist sessions that only open on certain days of the month." },
];

const PATIENT_ACTIONS = [
  { name: "Join the queue", text: "Patients scan your QR code and get a ticket, their place in line and an estimated wait. Nothing to install." },
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
  { name: "Share your QR code or link", text: "Patients can start queuing straight away." },
];

const TRUST_POINTS = [
  { name: "No patient names or clinical records", text: "QBooker doesn't ask for or store patient names or clinical records. Queue entries are ticket numbers." },
  { name: "Designed for GDPR", text: "Designed for GDPR: no patient names or clinical records are stored. Read our privacy notice for exactly what we hold." },
  { name: "Cyber Essentials", text: CE_CLAIM },
  ...(UK ? [{ name: "UK servers and support", text: "Your data stays in the UK, and when you need help you talk to someone in the same time zone." }] : []),
];

const FAQS = [
  { q: "Do patients need to install anything?", a: "No. Patients use their phone's browser, and can add WhatsApp updates if they want them." },
  { q: "Is it safe to use in an NHS setting?", a: `QBooker is designed not to capture or store patient names or clinical records. It's designed for GDPR. ${CE_CLAIM}${UK ? " It uses UK-based servers and a UK-based support team." : ""} See our privacy notice for the detail. As with any supplier, your organisation should run its own information governance checks.` },
  { q: "Can I use it for just one day?", a: "Yes. Licences are bought per service and can run for a day, a week, a month or any custom number of days, so a one-off clinic day costs a one-day licence." },
  { q: "What's the difference between queue, appointments and hybrid?", a: "A queue is walk-ins only, first come first served. Appointments are booked slots only. Hybrid runs both together in one service, so people on site can join the queue now while others reserve a slot for later." },
  { q: "Do patients need WhatsApp?", a: "No. The queue works in any phone browser, and WhatsApp updates are optional. Anyone without a smartphone can still turn up and your team adds them by hand." },
  { q: "Can I run more than one location?", a: "Yes. Each location gets its own sign-in code and queue, and staff only see their own." },
  { q: "How long does setup take?", a: "Under 2 minutes to create an account and add a service, and no training is needed. If you'd like help anyway, an engineer can join a one-hour call to set up your system and train your team for £125 (£150 inc VAT)." },
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

function WhatsAppIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#25D366" d="M12.04 2a9.9 9.9 0 0 0-8.5 14.95L2 22l5.2-1.5A9.9 9.9 0 1 0 12.04 2z" />
      <path fill="#fff" d="M8.6 7.4c-.2-.4-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.8 2.2.9 2.600.7 3.100.7.500-.1 1.500-.6 1.700-1.200.2-.6.2-1.100.2-1.200-.1-.1-.2-.2-.5-.3l-1.600-.8c-.2-.1-.4-.1-.5.100l-.7.9c-.1.2-.3.200-.5.100-.3-.1-1-.4-1.900-1.200-.7-.6-1.200-1.400-1.300-1.600-.1-.2 0-.4.100-.5l.4-.4c.1-.1.2-.3.200-.4.100-.2 0-.3 0-.4z" />
    </svg>
  );
}

function ShotsSection() {
  const shots = [
    { src: "/shots/dashboard.png", w: 1280, h: 1060, title: "Your dashboard", text: "See the whole day at a glance: places booked, free slots and who is queuing, for all services or one at a time." },
    { src: "/shots/staff.png", w: 1100, h: 760, title: "Your team's screen", text: "One button calls the next patient. Appointments that have checked in sit in the same list as walk-ins." },
  ];
  return (
    <section id="screens" className="lp-section lp-band-card">
      <div className="wide">
        <h2 className="lp-h2">See it working</h2>
        <p className="lp-lead" style={{ marginBottom: 40 }}>These are real screens from QBooker, not mock-ups.</p>
        <div className="lp-shots">
          {shots.map((x) => (
            <figure key={x.src} className="lp-shot">
              <img src={x.src} width={x.w} height={x.h} loading="lazy" alt={x.title} />
              <figcaption><strong>{x.title}</strong><span>{x.text}</span></figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function HybridTimeline() {
  return (
    <div className="lp-timeline-card" tabIndex={0} role="img" aria-label="A one-day clinic from 9am to 5pm. At 10:40am, patients on site join the queue as tickets 14, 15 and 16. Patients at work have reserved slots at 2pm, 3pm and 4pm. Both appear in the same queue.">
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
          <h1 className="lp-h1">A digital queue for your clinic, live in under 2 minutes</h1>
          <p className="lp-lead">QBooker is queue management for NHS and healthcare services that don't run every day. Patients scan a QR code and join from their phone, with optional WhatsApp updates. Your team calls them forward, and there's no hardware to buy or install.</p>
          <div className="lp-actions">
            <button className="btn-accent lp-start" onClick={onStart}>Start free trial</button>
            <div className="lp-free"><strong>2 free days</strong><span>No card needed</span></div>
          </div>
          <p style={{ margin: "-12px 0 24px" }}><a href="#hybrid" className="lp-link">See how the hybrid queue works</a></p>
          <ul className="lp-checks">
            <li>Pay by invoice with a purchase order, or by card</li>
            <li>Unlimited locations, staff users and patients</li>
            <li>No patient names or clinical records stored</li>
            {UK && <li>UK-based servers and support</li>}
          </ul>
        </div>

        <div className="lp-hero-visual lp-hero-shot">
          <img className="lp-phone" src="/shots/patient.png" width="390" height="780" alt="The patient's ticket screen: Riverside Blood Clinic, ticket BT-014, 3 in line, about 15 minutes, with a Get updates on WhatsApp button." />
          <div className="lp-wa-badge"><WhatsAppIcon size={22} /><span>Optional WhatsApp updates</span></div>
        </div>
      </section>

      {/* FACTS */}
      <section className="lp-band-navy lp-facts-band">
        <div className="wide lp-facts">
          <div><strong>Live in under 2 minutes</strong><p>Create an account, add a service and your queue is ready.</p></div>
          <div><strong>No hardware</strong><p>No kiosks, ticket printers or installation. Your team uses a web page.</p></div>
          <div><strong>No patient names stored</strong><p>QBooker doesn't capture patient names or clinical records.</p></div>
          {UK && <div><strong>UK-based support</strong><p>UK servers and a UK support team.</p></div>}
          <div><strong>Pay by service only</strong><p>Unlimited locations, staff users and patients. You only pay for each service you run.</p></div>
        </div>
      </section>

      <ShotsSection />

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
          <h2 className="lp-h2">Live in under 2 minutes, with nothing to learn</h2>
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
              <strong style={{ fontSize: 18 }}>£125 (£150 inc VAT)</strong>
              <a href={mailto("Setup assistance")}><button className="btn-outline">Book a call</button></a>
            </div>
          </div>
        </div>
      </section>

      {/* COMPLIANCE */}
      <section id="trust" className="lp-section lp-band-card">
        <div className="wide lp-split">
          <div>
            <h2 className="lp-h2">{UK ? "No patient names, and UK-based" : "No patient names or clinical records"}</h2>
            <p className="lp-lead">QBooker doesn't capture or store patient names or clinical records, which keeps information governance more straightforward.</p>
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
              <p style={{ margin: "0 0 12px", fontSize: 16, lineHeight: 1.55, maxWidth: 520 }}>After that, each service has its own licence for a day, a week, a month or a custom number of days.</p>
              <p style={{ margin: "0 0 16px", fontSize: 16, lineHeight: 1.55, maxWidth: 520, fontWeight: 600 }}>Unlimited locations, staff users and patients. You only pay for each service.</p>
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
                          <span className="muted" style={{ fontSize: 12 }}>({exMoney(incVat(onSale ? pricing.sale[k] : pricing[k]))} inc VAT)</span>
                          <span className="muted">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>All prices are per service. Need something in between? Choose a custom number of days. Want a full year? Annual licences are priced on application, so <a href={mailto("Annual licence")} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>contact us</a>.</p>
                </>
              )}
              <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 28, maxWidth: 520 }}>
                Already use Microsoft Bookings for appointments and only need queue management? We offer integration on request.{" "}
                <a href={mailto("MS Bookings integration")} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Get in touch</a> to discuss your setup.
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
            <p className="lp-lead">Something else? <a href={mailto()} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{UK ? "Email our UK support team" : "Email our support team"}</a>.</p>
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
          <div className="lp-actions" style={{ margin: 0 }}>
            <button className="btn-accent lp-start" onClick={onStart}>Start free trial</button>
            <div className="lp-free lp-free-dark"><strong>2 free days</strong><span>No card needed</span></div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="wide lp-footer-grid">
          <div>
            <Logo size={22} />
            <p className="muted" style={{ fontSize: 14, maxWidth: 280, lineHeight: 1.6, marginTop: 12 }}>Queue management for NHS and healthcare services.</p>
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
            <a href="/privacy" className="muted">Privacy</a>
            <a href={mailto()} className="muted">Support</a>
            <a href={ADMIN_APP_URL} className="muted">Log in</a>
          </div>
        </div>
        <div className="wide lp-footer-base">© QBooker · <a href="/privacy">Privacy notice</a></div>
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
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  // The hand-off token is good for two minutes and is swapped for a normal session by the admin portal, so the person lands
  // signed in. It travels in the URL fragment, which is never sent to any server.
  const dest = result.handoff ? `${ADMIN_APP_URL}#handoff=${encodeURIComponent(result.handoff)}` : ADMIN_APP_URL;
  useEffect(() => {
    if (!result.handoff) return undefined;
    const t = setTimeout(() => { window.location.assign(dest); }, result.demoOtp ? 60000 : 1200);
    return () => clearTimeout(t);
  }, [dest, result.handoff, result.demoOtp]);
  return (
    <main id="main" className="su-wrap su-wrap-narrow">
      <div className="su-card su-success">
        <div className="su-success-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 11.5l4.5 4.5L18 6.5" stroke="#fff" strokeWidth="2.5" fill="none" /></svg>
        </div>
        <h1 className="su-h1" tabIndex={-1} ref={headingRef}>{result.existing ? "Welcome back" : "You're set up"}</h1>
        <p className="su-p">
          {result.existing
            ? <>Your account for <strong>{result.businessName}</strong> is confirmed. Taking you to your dashboard…</>
            : <><strong>{result.businessName}</strong> is ready. Taking you to your dashboard…</>}
        </p>
        <a href={dest} className="su-btn su-btn-primary su-btn-block">Go to my dashboard →</a>
      </div>
    </main>
  );
}

const STEP_LABELS = ["Your details", "Locations", "Services", "Payment"];
const STEP_LABELS_FREE = ["Your details", "Locations", "Services"];

function StepHeader({ step, labels }) {
  const stepLabels = labels || STEP_LABELS;
  return (
    <nav aria-label="Sign-up progress">
      <p className="su-progress-text">Step {step} of {stepLabels.length}</p>
      <ol className="su-progress">
        {stepLabels.map((label, i) => {
          const num = i + 1;
          const state = num === step ? "active" : num < step ? "done" : "todo";
          return (
            <li key={label} className={state} aria-current={state === "active" ? "step" : undefined}>
              <span className="su-progress-n" aria-hidden="true">{state === "done" ? "✓" : num}</span>
              <span>{label}{state === "done" && <span className="sr-only"> (completed)</span>}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// A real <label> wired to the control (children is a single input/select), plus hint and
// error text linked through aria-describedby. Errors are announced via role="alert".
function Field({ label, hint, error, children }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="su-field">
      <label className="su-label" htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? "true" : undefined })}
      {hint && <div className="su-hint" id={hintId}>{hint}</div>}
      {error && <div className="su-error" id={errId} role="alert">{error}</div>}
    </div>
  );
}

function PaymentOption({ active, onClick, title, desc }) {
  return (
    <label className={active ? "su-pay active" : "su-pay"}>
      <input type="radio" name="payment-method" checked={active} onChange={onClick} />
      <span>
        <span className="su-pay-title">{title}</span>
        <span className="su-pay-desc">{desc}</span>
      </span>
    </label>
  );
}

function XIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" fill="none" /></svg>;
}

function ServiceRow({ svc, index, locationNames, pricing, nameError, onChange, onRemove, removable }) {
  return (
    <div className="su-service">
      <div className="su-service-head">
        <h3 className="su-h3">Service {index + 1}</h3>
        {removable && (
          <button type="button" className="su-link su-link-danger" onClick={onRemove} aria-label={`Remove service ${index + 1}`}>Remove</button>
        )}
      </div>
      <div className="su-grid two">
        <Field label="Service name" error={nameError}>
          <input className="su-input" placeholder="e.g. Blood Test" autoComplete="off" value={svc.name} onChange={(e) => onChange({ ...svc, name: e.target.value })} />
        </Field>
        <Field label="Location">
          <select className="su-input" value={svc.locationIndex} onChange={(e) => onChange({ ...svc, locationIndex: Number(e.target.value) })}>
            {locationNames.map((n, i) => <option key={i} value={i}>{n.trim() || `Location ${i + 1}`}</option>)}
          </select>
        </Field>
        <div className="su-span">
        <Field label="How does this work?">
          <select className="su-input" value={svc.mode} onChange={(e) => onChange({ ...svc, mode: e.target.value })}>
            {SERVICE_MODE_META.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        </div>
        {svc.mode !== "queue" && (
          <Field label="Slot length">
            <select className="su-input" value={svc.slotMinutes} onChange={(e) => onChange({ ...svc, slotMinutes: Number(e.target.value) })}>
              {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </Field>
        )}
      </div>
      <p className="su-hint">Can't be changed after signup — delete and recreate the service in your admin dashboard if you need to change it later.</p>
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
  // Email check, done on step 1 before anything else: a code is emailed and must be entered before the setup continues.
  const [verifyStage, setVerifyStage] = useState(false);
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [signupToken, setSignupToken] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const emailKey = email.trim().toLowerCase();
  const emailVerified = !!signupToken && verifiedEmail === emailKey;

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
  // Validation messages only appear once the person has tried to continue.
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const headingRef = useRef(null);
  const submitErrorRef = useRef(null);
  const firstRender = useRef(true);

  const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);
  useEffect(() => {
    setAttempted(false);
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    // Move focus to the new step's heading so screen readers announce the change.
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (submitError) {
      submitErrorRef.current?.focus({ preventScroll: true });
      submitErrorRef.current?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }, [submitError]);

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

  async function sendCode() {
    setSubmitting(true); setError(""); setSubmitError("");
    try {
      const r = await api.requestSignupCode(email.trim());
      setDemoCode(r.demoOtp || ""); setCode(""); setVerifyStage(true);
    } catch (err) { setSubmitError(err.message); }
    finally { setSubmitting(false); }
  }
  async function checkCode() {
    setSubmitting(true); setError(""); setSubmitError("");
    try {
      const r = await api.verifySignupCode(email.trim(), code.trim());
      if (r.existing) { onDone({ existing: true, businessName: r.businessName, handoff: r.handoff }); return; }
      setSignupToken(r.signupToken); setVerifiedEmail(emailKey); setVerifyStage(false);
      next();
    } catch (err) { setSubmitError(err.message); }
    finally { setSubmitting(false); }
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    setSubmitError("");
    try {
      // Nothing to charge — every service's license came out free (e.g. a sale or £0
      // pricing), so there's no payment method to collect; bill as "card" with no
      // invoice fields since there's nothing to invoice either.
      const payload = {
        businessName, firstName, lastName, signupToken,
        locations: locationNames.map((n) => ({ name: n.trim() })),
        services: services.map((s) => ({
          name: s.name.trim(), locationIndex: s.locationIndex, mode: s.mode, slotMinutes: s.slotMinutes,
        })),
      };
      const result = await api.signup(payload);
      onDone(result);
    } catch (err) {
      // Shown inline next to the actions (the page-level banner can be off-screen on phones).
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function focusFirstInvalid() {
    setTimeout(() => { document.querySelector('#su-form [aria-invalid="true"]')?.focus(); }, 0);
  }

  function onFormSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    const valid = step === 1 && verifyStage ? /^\d{6}$/.test(code.trim()) : [step1Valid, step2Valid, step3Valid, step4Valid][step - 1];
    if (!valid) {
      setAttempted(true);
      if (step === 3) {
        const firstBad = services.findIndex((s) => !isServiceValid(s));
        if (firstBad >= 0) setActiveService(firstBad);
      }
      focusFirstInvalid();
      return;
    }
    if (step === 1 && !emailVerified) { if (verifyStage) checkCode(); else sendCode(); return; }
    if (step < lastStep) next();
    else submit();
  }

  const missing = (v) => (attempted && !String(v).trim());
  const badServices = attempted ? services.map((s, i) => (isServiceValid(s) ? -1 : i)).filter((i) => i >= 0) : [];
  const primaryLabel = submitting ? "Please wait…"
    : step === 1 && !emailVerified ? (verifyStage ? "Confirm email" : "Send me a code")
    : step < lastStep ? "Continue" : "Create account";

  return (
    <main id="main" className="su-wrap">
      <div className="su-intro">
        <button type="button" onClick={onBackToLanding} className="su-link">← Back to overview</button>
        <h1 className="su-h1">Set up your account</h1>
      </div>
      <StepHeader step={step} labels={stepLabels} />

      <form id="su-form" className="su-card" onSubmit={onFormSubmit} noValidate>
        {step === 1 && verifyStage && !emailVerified && (
          <div className="su-stack">
            <div>
              <h2 className="su-h2" tabIndex={-1} ref={headingRef}>Check your email</h2>
              <p className="su-hint">We've sent a 6-digit code to <strong style={{ overflowWrap: "anywhere" }}>{email.trim()}</strong>. It works once and expires in 10 minutes. Check your junk folder if it doesn't arrive.</p>
            </div>
            <div className="su-field">
              <span className="su-label">Enter your 6-digit code</span>
              <CodeBoxes value={code} onChange={setCode} onEnter={() => { if (/^\d{6}$/.test(code)) checkCode(); }} invalid={attempted && code.length < 6} describedBy={attempted && code.length < 6 ? "su-code-err" : undefined} />
              {attempted && code.length < 6 && <div className="su-error" id="su-code-err" role="alert">Enter the 6-digit code from the email.</div>}
            </div>
            {demoCode && (
              <div className="su-code" role="group" aria-label="Demo code">
                <span className="su-code-label">Demo code (simulated email)</span>
                <span className="su-code-value mono">{demoCode}</span>
              </div>
            )}
            <p className="su-hint">
              <button type="button" className="su-link" onClick={sendCode} disabled={submitting}>Send a new code</button>
              {" · "}
              <button type="button" className="su-link" onClick={() => { setVerifyStage(false); setCode(""); setSubmitError(""); }}>Use a different email address</button>
            </p>
          </div>
        )}
        {step === 1 && !(verifyStage && !emailVerified) && (
          <div className="su-stack">
            <div>
              <h2 className="su-h2" tabIndex={-1} ref={headingRef}>Your details</h2>
              <p className="su-hint">Who's setting this account up, and how we'll reach you. All fields are required.</p>
            </div>
            <Field label="Business name" error={missing(businessName) ? "Enter your business name." : null}>
              <input className="su-input" autoComplete="organization" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            </Field>
            <div className="su-grid two">
              <Field label="First name" error={missing(firstName) ? "Enter your first name." : null}>
                <input className="su-input" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </Field>
              <Field label="Last name" error={missing(lastName) ? "Enter your last name." : null}>
                <input className="su-input" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </Field>
            </div>
            <Field
              label="Email address"
              hint="This is what you'll sign in with. We'll email you a code to confirm it now, and a new one each time you sign in — no password to remember."
              error={missing(email) ? "Enter your email address." : null}
            >
              <input className="su-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <p className="su-hint">You can add your business address later from the Account tab once you're set up.</p>
          </div>
        )}

        {step === 2 && (
          <div className="su-stack">
            <div>
              <h2 className="su-h2" tabIndex={-1} ref={headingRef}>Add your locations</h2>
              <p className="su-hint">
                Locations are free and unlimited — they're just how patients and staff get routed to the right place.
                Name each one now; each name must be unique. You'll pick services and licenses next.
              </p>
            </div>
            <div className="su-stack" style={{ gap: 14 }}>
              {locationNames.map((name, i) => {
                const empty = attempted && !name.trim();
                const dupe = hasDuplicateNames && normalizedNames.filter((n) => n === normalizedNames[i]).length > 1;
                const inputId = `su-loc-${i}`;
                return (
                  <div key={i} className="su-loc">
                    <label className="su-label" htmlFor={inputId}>Location {i + 1} name</label>
                    <div className="su-loc-line">
                      <input
                        id={inputId}
                        className="su-input"
                        autoComplete="off"
                        placeholder="e.g. Riverside Clinic"
                        aria-invalid={empty || dupe ? "true" : undefined}
                        aria-describedby={empty || dupe ? "su-loc-error" : undefined}
                        value={name}
                        onChange={(e) => updateLocationName(i, e.target.value)}
                      />
                      <button
                        type="button"
                        className="su-loc-rm"
                        onClick={() => removeLocation(i)}
                        disabled={locationNames.length <= 1}
                        aria-label={`Remove location ${i + 1}`}
                        title={locationNames.length <= 1 ? "At least one location is required" : "Remove this location"}
                      >
                        <XIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
              <button type="button" className="su-add" onClick={addLocation} disabled={locationNames.length >= MAX_LOCATIONS}>+ Add another location</button>
            </div>
            {(hasDuplicateNames || (attempted && !namesFilled)) && (
              <div className="su-error" id="su-loc-error" role="alert">
                {hasDuplicateNames
                  ? "Each location needs its own name — two locations currently share the same name."
                  : "Give every location a name before continuing."}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="su-stack" style={{ gap: 16 }}>
            <div>
              <h2 className="su-h2" tabIndex={-1} ref={headingRef}>Add your services</h2>
              <p className="su-hint">
                Each service belongs to one location. Your 2 free days go on the first service you add, and you choose
                which two days from its calendar once you're in. Start today, even part-way through the day, or pick a future date, so nothing is wasted while you're still setting up.
              </p>
            </div>
            <div className="su-stack" style={{ gap: 12 }}>
              <p className="su-count">Service {activeService + 1} of {services.length}</p>
              {services.length > 1 && (
                <div className="su-chips" role="group" aria-label="Choose a service to edit">
                  {services.map((s, i) => {
                    const bad = badServices.includes(i);
                    return (
                      <button
                        type="button"
                        key={i}
                        className={`su-chip${i === activeService ? " on" : ""}${bad ? " bad" : ""}`}
                        aria-pressed={i === activeService}
                        onClick={() => setActiveService(i)}
                        aria-label={`Service ${i + 1}${s.name.trim() ? `: ${s.name.trim()}` : ""}${isServiceValid(s) ? "" : ", needs a name"}`}
                      >
                        {i + 1}{isServiceValid(s) ? <span aria-hidden="true"> ✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <ServiceRow
                key={activeService}
                svc={services[activeService]}
                index={activeService}
                locationNames={locationNames}
                pricing={pricing}
                nameError={missing(services[activeService].name) ? "Enter a name for this service." : null}
                onChange={(next) => updateService(activeService, next)}
                onRemove={() => removeService(activeService)}
                removable={services.length > 1}
              />
              {badServices.filter((i) => i !== activeService).length > 0 && (
                <div className="su-error" role="alert">
                  {badServices.filter((i) => i !== activeService).map((i) => `Service ${i + 1}`).join(", ")} still need{badServices.filter((i) => i !== activeService).length === 1 ? "s" : ""} a name.
                </div>
              )}
              <button type="button" className="su-add" onClick={addService} disabled={services.length >= MAX_SERVICES}>+ Add another service</button>
            </div>

            <div className="su-note"><strong>2 free days</strong> — no card needed. Add more licences whenever you're ready.</div>
          </div>
        )}

        {step === 4 && needsPayment && (
          <div className="su-stack">
            <h2 className="su-h2" tabIndex={-1} ref={headingRef}>How would you like to pay?</h2>
            <fieldset className="su-fieldset">
              <legend className="sr-only">Payment method</legend>
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
                desc="Your account can be fully configured straight away, but staff kiosk and patient WhatsApp won't be enabled until payment is received."
              />
              <PaymentOption
                active={paymentMethod === "later"}
                onClick={() => setPaymentMethod("later")}
                title="Pay later"
                desc="Get set up and explore the system now — staff kiosk and patient WhatsApp switch on once we've sorted payment with you."
              />
            </fieldset>
            {paymentMethod === "invoice" && (
              <div className="su-stack">
                <Field label="Billing email" error={missing(invoiceEmail) ? "Enter a billing email." : null}>
                  <input className="su-input" type="email" inputMode="email" autoComplete="email" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
                </Field>
                <Field label="PO / reference number" hint="Required for invoice payment — your internal purchase order or reference number." error={missing(poNumber) ? "Enter a PO or reference number." : null}>
                  <input className="su-input" autoComplete="off" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
                </Field>
              </div>
            )}

            <div className="su-note su-total">
              <span>{services.length} service license{services.length === 1 ? "" : "s"}</span>
              <span>Total: <strong>{priceText(total)}</strong></span>
            </div>
          </div>
        )}

        {submitError && (
          <div className="su-alert" role="alert" tabIndex={-1} ref={submitErrorRef} style={{ marginTop: 16 }}>
            <span>{submitError}</span>
          </div>
        )}
      </form>

      <p className="su-hint" style={{ textAlign: "center", margin: "16px 0 0" }}>
        By creating an account you confirm you have read our <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>privacy notice</a>.
      </p>

      <div className="su-bar">
        <div className="su-bar-in">
          <p className="su-bar-note"><strong>2 free days</strong> · no card needed</p>
          <div className="su-bar-actions">
            {step > 1 && <button type="button" className="su-btn su-btn-outline" onClick={back}>Back</button>}
            <button type="submit" form="su-form" className="su-btn su-btn-primary" disabled={submitting} aria-busy={submitting || undefined}>{primaryLabel}</button>
          </div>
        </div>
      </div>
    </main>
  );
}
