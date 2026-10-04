import { useState, useEffect } from "react";
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

const TABS = [
  {
    id: 1,
    label: "Booking",
    items: [
      { title: "Book by message", text: "Customers pick a time without leaving the chat they already have open." },
      { title: "Reminders that send themselves", text: "Automatic confirmation and a reminder before the slot." },
      { title: "Reschedule in one line", text: "No phone tag — they just reply to move it." },
    ],
  },
  {
    id: 2,
    label: "Queue management",
    items: [
      { title: "Live queue, no hardware", text: "Walk-ins join by message; the counter screen updates itself." },
      { title: "Wait time, told straight", text: "Customers get a real estimate, not a guess at the door." },
      { title: "Multiple locations, one view", text: "Every location gets its own code and queue, all visible from one place." },
    ],
  },
  {
    id: 3,
    label: "Client experience",
    items: [
      { title: "No app to download", text: "Everything happens in the chat app already on their phone." },
      { title: "Answers, any time", text: "Opening hours and availability, answered automatically out of hours." },
      { title: "Feels personal", text: "A real conversation, not a form — because it is one." },
    ],
  },
];

const INDUSTRIES = [
  { icon: "✂", name: "Barbers & salons" },
  { icon: "✚", name: "Clinics & practices" },
  { icon: "🧖", name: "Spas & studios" },
  { icon: "🔧", name: "Repair shops" },
  { icon: "🛍", name: "Independent shops" },
  { icon: "🐾", name: "Groomers & vets" },
];

const TESTIMONIALS = [
  { quote: "[QUOTE]", name: "[Name]", role: "[Business, location]" },
  { quote: "[QUOTE]", name: "[Name]", role: "[Business, location]" },
  { quote: "[QUOTE]", name: "[Name]", role: "[Business, location]" },
];

function Landing({ onStart, simulatedBadge }) {
  const [pricing, setPricing] = useState(null);
  const [activeTab, setActiveTab] = useState(1);

  useEffect(() => { api.publicPricing().then((r) => setPricing(r.pricing)).catch(() => {}); }, []);

  const currentTab = TABS.find((t) => t.id === activeTab);

  return (
    <div id="top">
      {/* NAV */}
      <div style={{ background: "var(--surface-card)", borderBottom: "1px solid var(--line)" }}>
        <div className="container row" style={{ justifyContent: "space-between", paddingTop: 18, paddingBottom: 18, flexWrap: "wrap", gap: 12 }}>
          <Logo />
          <nav className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", padding: "10px 14px" }}>Product</span>
            <a href="#industries" style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", padding: "10px 14px" }}>Industries</a>
            <a href="#pricing" style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", padding: "10px 14px" }}>Pricing</a>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", padding: "10px 14px" }}>Resources</span>
          </nav>
          <div className="row" style={{ gap: 14 }}>
            {simulatedBadge && <span className="badge badge-amber">Simulated date: {simulatedBadge}</span>}
            <a href={ADMIN_APP_URL} style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)" }}>Log in</a>
            <button className="btn-ink" onClick={onStart}>Start free</button>
          </div>
        </div>
      </div>

      {/* HERO */}
      <div className="container" style={{ paddingTop: 72, paddingBottom: 72 }}>
        <div style={{ display: "flex", gap: 56, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 440px", minWidth: 0 }}>
            <span className="tag">For clinics, salons and shops</span>
            <h1 style={{ fontSize: 52, lineHeight: 1.08, fontWeight: 700, letterSpacing: "-0.03em", margin: "18px 0 20px" }}>
              Booking, where your customers already message you
            </h1>
            <p className="lead">QBooker turns WhatsApp into your front desk — customers join the queue or book a slot by chatting, staff see it update live. No app for them to download.</p>
            <div className="row" style={{ gap: 12, marginTop: 30, flexWrap: "wrap" }}>
              <button className="btn-accent" onClick={onStart}>Start free</button>
              <a href="#features"><button className="btn-outline">See how it works</button></a>
            </div>
            <div className="muted" style={{ marginTop: 16, fontSize: 13 }}>No card required · set up in an afternoon</div>
          </div>
          <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", gap: 16 }}>
            <div className="card" style={{ flex: 1, padding: 18 }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, marginBottom: 12 }}>The conversation</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ alignSelf: "flex-start", maxWidth: "85%", background: "var(--surface-page)", borderRadius: "10px 10px 10px 2px", padding: "9px 12px", fontSize: 13 }}>Hi — can I get a slot today?</div>
                <div style={{ alignSelf: "flex-end", maxWidth: "85%", background: "var(--navy)", color: "#fff", borderRadius: "10px 10px 2px 10px", padding: "9px 12px", fontSize: 13 }}>You're #3 in the queue — about 20 min</div>
                <div style={{ alignSelf: "flex-start", maxWidth: "85%", background: "var(--surface-page)", borderRadius: "10px 10px 10px 2px", padding: "9px 12px", fontSize: 13 }}>Perfect, see you soon</div>
              </div>
            </div>
            <div className="card" style={{ flex: 1, padding: 18 }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, marginBottom: 12 }}>The dashboard</div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Riverside Clinic</span>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--accent)", display: "inline-block" }} />
              </div>
              <div className="mono muted" style={{ fontSize: 11, margin: "6px 0 14px" }}>QB-7F3K2A</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12, borderTop: "1px solid var(--line)", paddingTop: 8 }}><span>#3 J. Patel</span><span className="mono muted">waiting</span></div>
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12, borderTop: "1px solid var(--line)", paddingTop: 8 }}><span>#2 S. Ahmed</span><span className="mono muted">waiting</span></div>
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12, borderTop: "1px solid var(--line)", paddingTop: 8 }}><span>#1 R. Okafor</span><span className="mono" style={{ color: "var(--accent)" }}>now serving</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SOCIAL PROOF */}
      <div style={{ background: "var(--navy)", padding: "28px 0" }}>
        <div className="container row" style={{ justifyContent: "center", gap: 48, flexWrap: "wrap", color: "#fff" }}>
          <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.85 }}>Built for independent clinics, salons and shops across the UK</span>
          <span className="mono" style={{ fontSize: 13, opacity: 0.7 }}>[locations live]</span>
          <span className="mono" style={{ fontSize: 13, opacity: 0.7 }}>[bookings this month]</span>
          <span className="mono" style={{ fontSize: 13, opacity: 0.7 }}>[avg. setup time: an afternoon]</span>
        </div>
      </div>

      {/* FEATURE TABS */}
      <div id="features" className="container" style={{ padding: "88px 0" }}>
        <h2 className="h2">Everything the front desk used to do</h2>
        <p className="lead" style={{ marginBottom: 34 }}>Three jobs, one chat thread.</p>
        <div className="row" style={{ gap: 4, borderBottom: "1px solid var(--line)", marginBottom: 32 }}>
          {TABS.map((t) => (
            <button key={t.id} className={activeTab === t.id ? "navbtn active" : "navbtn"} onClick={() => setActiveTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 20 }}>
          {currentTab.items.map((item) => (
            <div key={item.title} className="card">
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{item.title}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{item.text}</div>
            </div>
          ))}
        </div>
      </div>

      {/* INDUSTRIES */}
      <div id="industries" style={{ background: "var(--surface-card)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "88px 0" }}>
        <div className="container">
          <h2 className="h2">Built around how you already work</h2>
          <p className="lead" style={{ marginBottom: 34 }}>Pick your trade — the setup is the same conversation either way.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
            {INDUSTRIES.map((ind) => (
              <div key={ind.name} className="card row" style={{ gap: 12 }}>
                <div style={{ width: 40, height: 40, background: "var(--surface-page)", border: "1px solid var(--line)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>{ind.icon}</div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{ind.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* TRUST STRIP */}
      <div className="container row" style={{ justifyContent: "center", gap: 40, flexWrap: "wrap", padding: "36px 0" }}>
        <span className="mono muted" style={{ fontSize: 12 }}>WhatsApp Business API</span>
        <span className="mono muted" style={{ fontSize: 12 }}>GDPR-ready</span>
        <span className="mono muted" style={{ fontSize: 12 }}>UK-hosted data</span>
        <span className="mono muted" style={{ fontSize: 12 }}>No long-term contract</span>
      </div>

      {/* PRICING — real data from the API */}
      {pricing && (
        <div id="pricing" className="container" style={{ padding: "88px 0" }}>
          <span className="tag">Pricing</span>
          <h2 className="h2" style={{ marginTop: 14 }}>Try it before you commit</h2>
          <p className="lead" style={{ marginBottom: 34 }}>Buy exactly as much time as you need to test it properly — per service.</p>
          {pricing.sale?.active && (
            <p style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, marginTop: -20, marginBottom: 20 }}>Sale on selected plans — see below</p>
          )}
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            {["day", "week", "month", "year"].map((k) => {
              const label = { day: "Day", week: "Week", month: "Month", year: "Year" }[k];
              const onSale = pricing.sale?.active && pricing.sale[k] != null;
              return (
                <div key={k} className="card stack" style={{ minWidth: 160, textAlign: "center" }}>
                  {onSale && <span className="muted" style={{ fontSize: 13, textDecoration: "line-through" }}>£{pricing[k]}</span>}
                  <strong style={{ fontSize: 22, color: onSale ? "var(--accent)" : undefined }}>£{onSale ? pricing.sale[k] : pricing[k]}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{label}</span>
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>All prices per service. Need something in between? Choose a custom period at signup.</p>
          <div className="row" style={{ gap: 16, marginTop: 28, flexWrap: "wrap", alignItems: "stretch" }}>
            <div className="card row" style={{ justifyContent: "space-between", flex: "1 1 320px", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Want a hand getting set up?</div>
                <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>Our team will configure your services, hours, and staff for you — done in one session.</p>
              </div>
              <div className="row" style={{ gap: 10 }}>
                <strong>£125</strong>
                <a href="mailto:hello@qbooker.example?subject=Setup%20assistance"><button className="btn-outline">Get in touch</button></a>
              </div>
            </div>
            <div className="card stack" style={{ flex: "1 1 320px" }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Just need a simple queue?</div>
              <p className="muted" style={{ fontSize: 13 }}>
                If you already use Microsoft Bookings for appointments and only need queue management,
                we offer integration on request — <a href="mailto:hello@qbooker.example?subject=MS%20Bookings%20integration" style={{ textDecoration: "underline" }}>get in touch</a> to discuss your setup.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* FEATURE DEEP-DIVE 1 */}
      <div style={{ padding: "88px 0" }}>
        <div className="container" style={{ display: "flex", gap: 56, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <div className="card" style={{ padding: 22 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Central Clinic</div>
                  <div className="mono muted" style={{ fontSize: 11, marginTop: 3 }}>QB-7F3K2A</div>
                </div>
                <span style={{ padding: "4px 10px", background: "var(--accent-weak)", color: "var(--accent)", fontSize: 11, fontWeight: 700 }}>Live</span>
              </div>
              <div style={{ height: 1, background: "var(--line)", margin: "16px 0" }} />
              <div className="muted" style={{ fontSize: 13 }}>Now serving</div>
              <div className="mono" style={{ fontSize: 40, fontWeight: 600, marginTop: 4 }}>#12</div>
            </div>
          </div>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <span className="tag">Queue status</span>
            <h2 className="h2" style={{ marginTop: 14 }}>Always live, never a guess</h2>
            <p className="lead">Every location gets its own queue number and status, updated the moment someone's served — on the counter screen and in the chat, at the same time.</p>
          </div>
        </div>
      </div>

      {/* FEATURE DEEP-DIVE 2 */}
      <div style={{ background: "var(--surface-card)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "88px 0" }}>
        <div className="container" style={{ display: "flex", gap: 56, alignItems: "center", flexWrap: "wrap", flexDirection: "row-reverse" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <div className="stack" style={{ gap: 10 }}>
              <div className="card row" style={{ justifyContent: "space-between", padding: "14px 18px" }}><span style={{ fontSize: 13, fontWeight: 600 }}>Central Clinic</span><span className="mono muted" style={{ fontSize: 11 }}>QB-7F3K2A</span></div>
              <div className="card row" style={{ justifyContent: "space-between", padding: "14px 18px" }}><span style={{ fontSize: 13, fontWeight: 600 }}>Riverside Clinic</span><span className="mono muted" style={{ fontSize: 11 }}>QB-91MZQ</span></div>
              <div className="card row" style={{ justifyContent: "space-between", padding: "14px 18px" }}><span style={{ fontSize: 13, fontWeight: 600 }}>Old High Street</span><span className="mono muted" style={{ fontSize: 11 }}>QB-3DT0P</span></div>
            </div>
          </div>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <span className="tag">Multi-location</span>
            <h2 className="h2" style={{ marginTop: 14 }}>One number, every location</h2>
            <p className="lead">Add a second site in minutes — its own queue, its own code, no second setup to learn. Staff only ever see their own location's line.</p>
          </div>
        </div>
      </div>

      {/* TESTIMONIALS */}
      <div className="container" style={{ padding: "88px 0" }}>
        <h2 className="h2" style={{ textAlign: "center" }}>What's working, from people using it</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 20, marginTop: 34 }}>
          {TESTIMONIALS.map((t, i) => (
            <div key={i} className="card">
              <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" }}>"{t.quote}"</p>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{t.role}</div>
            </div>
          ))}
        </div>
        <div className="muted" style={{ textAlign: "center", marginTop: 18, fontSize: 12 }}>[real customer quotes go here]</div>
      </div>

      {/* FAQ */}
      <div id="faq" style={{ background: "var(--surface-card)", borderTop: "1px solid var(--line)", padding: "88px 0" }}>
        <div className="container" style={{ maxWidth: 760 }}>
          <h2 className="h2">Questions people ask before switching</h2>
          <div style={{ marginTop: 24 }}>
            <FaqItem q="Do my customers need to install anything?" a="No — booking and queueing happen inside WhatsApp, which almost everyone already has." />
            <FaqItem q="What if a customer doesn't use WhatsApp?" a="They can still call or walk in as normal; staff add them to the same queue by hand." />
            <FaqItem q="Can I run more than one location?" a="Yes — each location gets its own code and queue, and staff only see their own." />
            <FaqItem q="How long does setup take?" a="Most businesses are taking their first booking the same afternoon. If you'd rather have it done for you, we offer paid setup assistance for £125." />
            <FaqItem q="Is there a contract?" a="No long-term contract — buy a day, week, month or year at a time, cancel any time." />
          </div>
        </div>
      </div>

      {/* FINAL CTA */}
      <div style={{ background: "var(--navy)", padding: "76px 0", textAlign: "center" }}>
        <div className="container">
          <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em", color: "#fff", margin: "0 0 16px" }}>Ready to let the chat do the booking?</h2>
          <p style={{ fontSize: 16, color: "rgba(255,255,255,0.7)", maxWidth: 480, margin: "0 auto 28px" }}>No card required. Set up your first location this afternoon.</p>
          <button className="btn-accent" onClick={onStart}>Start free</button>
        </div>
      </div>

      {/* FOOTER */}
      <div style={{ padding: "56px 0 32px" }}>
        <div className="container" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 32 }}>
          <div>
            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <Logo size={22} />
            </div>
            <p className="muted" style={{ fontSize: 13, maxWidth: 260, lineHeight: 1.6 }}>Booking and queue management over WhatsApp, for clinics, salons and shops.</p>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>Product</span>
            <span className="muted" style={{ fontSize: 13 }}>Booking</span>
            <span className="muted" style={{ fontSize: 13 }}>Queue management</span>
            <a href="#pricing" className="muted" style={{ fontSize: 13 }}>Pricing</a>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>Industries</span>
            <span className="muted" style={{ fontSize: 13 }}>Clinics</span>
            <span className="muted" style={{ fontSize: 13 }}>Salons &amp; spas</span>
            <span className="muted" style={{ fontSize: 13 }}>Shops</span>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>Company</span>
            <a href="mailto:hello@qbooker.example" className="muted" style={{ fontSize: 13 }}>Support</a>
            <span className="muted" style={{ fontSize: 13 }}>About</span>
            <span className="muted" style={{ fontSize: 13 }}>Privacy</span>
          </div>
        </div>
        <div className="container" style={{ borderTop: "1px solid var(--line)", marginTop: 40, paddingTop: 20, fontSize: 12, color: "var(--muted)" }}>© QBooker</div>
      </div>
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
  const price = servicePlanPrice(svc, pricing);
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

      <div style={{ borderTop: "1px solid var(--line)" }} />

      <div className="plan-grid">
        {PLAN_META.map((p) => {
          const onSale = p.id !== "custom" && pricing.sale?.active && pricing.sale[p.id] != null;
          const planPrice = p.id === "custom" ? null : (onSale ? pricing.sale[p.id] : pricing[p.id]);
          return (
            <button key={p.id} type="button" className={svc.planId === p.id ? "plan-option active" : "plan-option"} onClick={() => onChange({ ...svc, planId: p.id })}>
              <span className="plan-option-label">{p.label}</span>
              {planPrice != null && <span className="plan-option-price">£{planPrice}</span>}
              {p.id === "custom" && <span className="plan-option-price">from £{pricing.customDailyRate}/day</span>}
            </button>
          );
        })}
      </div>
      {svc.planId === "custom" && (
        <Field label="Number of days">
          <input className="input" type="number" min={1} value={svc.customDays} onChange={(e) => onChange({ ...svc, customDays: Number(e.target.value) })} style={{ maxWidth: 120 }} />
        </Field>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <span className="muted" style={{ fontSize: 12 }}>License for this service: <strong style={{ color: "var(--ink)" }}>£{price}</strong></span>
      </div>
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
  const needsPayment = Number(total) > 0;
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
  const step4Valid = paymentMethod === "card" || (invoiceEmail.trim() && poNumber.trim());

  function next() { setStep((s) => Math.min(lastStep, s + 1)); }
  function back() { setStep((s) => Math.max(1, s - 1)); }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      // Nothing to charge — every service's license came out free (e.g. a sale or £0
      // pricing), so there's no payment method to collect; bill as "card" with no
      // invoice fields since there's nothing to invoice either.
      const effectivePaymentMethod = needsPayment ? paymentMethod : "card";
      const payload = {
        businessName, firstName, lastName, email,
        paymentMethod: effectivePaymentMethod,
        invoiceEmail: needsPayment ? invoiceEmail : "",
        invoicePO: needsPayment ? poNumber : "",
        locations: locationNames.map((n) => ({ name: n.trim() })),
        services: services.map((s) => ({
          name: s.name.trim(), locationIndex: s.locationIndex, mode: s.mode, slotMinutes: s.slotMinutes,
          planId: s.planId, customDays: s.planId === "custom" ? Number(s.customDays) : undefined,
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
                Each service belongs to one location and gets its own license — pick whatever length fits (a day, a week,
                a month, a year, or a custom number of days). Access begins the moment you set opening hours for it,
                whenever you're actually ready — nothing is wasted while you're still setting up.
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
              <span className="muted" style={{ fontSize: 12 }}>{services.length} service license{services.length === 1 ? "" : "s"}</span>
              <strong>Total: £{total}</strong>
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
              <span>Total: <strong>£{total}</strong></span>
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
