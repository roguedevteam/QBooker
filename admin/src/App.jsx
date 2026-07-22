import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api, setToken, hasToken } from "./lib/api.js";

const PLAN_LABELS = { day: "Day", week: "Week", month: "Month", year: "Year", custom: "Custom" };

export default function App() {
  const [signedIn, setSignedIn] = useState(hasToken());
  const [error, setError] = useState("");

  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} setError={setError} error={error} />;
  return <Dashboard setError={setError} error={error} onSignOut={() => { setToken(null); setSignedIn(false); }} />;
}

function Login({ onSignedIn, setError, error }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const r = await api.login(password);
      setToken(r.token);
      onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="narrow" style={{ paddingTop: 80 }}>
      <div className="card stack">
        <h2>QBooker — System Admin</h2>
        <p className="muted" style={{ fontSize: 13 }}>Platform team only. Not linked from the customer-facing site.</p>
        <input
          className="input" type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn" disabled={submitting} onClick={submit}>{submitting ? "Signing in…" : "Sign in"}</button>
        {error && <div style={{ color: "#C22A1E", fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}

function Dashboard({ setError, error, onSignOut }) {
  const [tab, setTab] = useState("dashboard");
  const [tenants, setTenants] = useState([]);
  const [pricing, setPricing] = useState({ day: 25, week: 100, month: 200, year: 600, customDailyRate: 20, sale: { active: false } });
  const [overview, setOverview] = useState(null);

  async function refresh() {
    try {
      const [t, p, o] = await Promise.all([api.getTenants(), api.getPricing(), api.getReportsOverview()]);
      setTenants(t.tenants);
      setPricing((prev) => ({ ...prev, ...p.pricing }));
      setOverview(o);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { refresh(); }, []);

  const chartData = overview
    ? Object.entries(overview.revenueByPlan).map(([planId, revenue]) => ({ name: PLAN_LABELS[planId] || planId, Revenue: revenue }))
    : [];

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>QBooker System Admin</strong>
        <button className="btn-outline" onClick={onSignOut}>Sign out</button>
      </div>
      {error && <div className="card" style={{ borderColor: "#C22A1E", color: "#C22A1E" }}>{error}</div>}
      <div className="wrap">
        {["dashboard", "customers", "pricing", "testing"].map((t) => (
          <button key={t} className={tab === t ? "btn" : "btn-outline"} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "dashboard" && overview && (
        <div className="stack">
          <div className="wrap">
            <div className="card">£{overview.totalRevenue.toFixed(2)}<div className="muted" style={{ fontSize: 11 }}>Revenue (active)</div></div>
            <div className="card">£{overview.pendingRevenue.toFixed(2)}<div className="muted" style={{ fontSize: 11 }}>Pending invoices</div></div>
            <div className="card">{overview.customerCount}<div className="muted" style={{ fontSize: 11 }}>Customers</div></div>
            <div className="card">{overview.totalLocations}<div className="muted" style={{ fontSize: 11 }}>Locations, all customers</div></div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Revenue by plan type (active customers)</div>
            <div className="chart-wrap">
              <ResponsiveContainer>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#DCE4EA" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="Revenue" fill="#0F5FBF" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {chartData.length === 0 && <div className="muted" style={{ textAlign: "center", padding: 20 }}>No active customers yet.</div>}
          </div>
        </div>
      )}

      {tab === "customers" && (
        <div className="card">
          <table>
            <thead><tr><th>Business</th><th>Email</th><th>Plan</th><th>Locations</th><th>Price</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {tenants.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: "center", padding: 20 }}>No customers yet.</td></tr>}
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input className="input" style={{ width: 140 }} defaultValue={t.business_name}
                      onBlur={async (e) => { if (e.target.value !== t.business_name) { await api.updateTenant(t.id, { businessName: e.target.value }); refresh(); } }} />
                  </td>
                  <td>
                    <input className="input" style={{ width: 160 }} defaultValue={t.email}
                      onBlur={async (e) => { if (e.target.value !== t.email) { await api.updateTenant(t.id, { email: e.target.value }); refresh(); } }} />
                  </td>
                  <td>{t.plan_label}</td>
                  <td>
                    <input className="input" type="number" style={{ width: 60 }} defaultValue={t.location_count}
                      onBlur={async (e) => { if (Number(e.target.value) !== t.location_count) { await api.updateTenant(t.id, { locationCount: Number(e.target.value) }); refresh(); } }} />
                  </td>
                  <td>£{t.price}</td>
                  <td><span className={`badge badge-${t.status === "active" ? "green" : "amber"}`}>{t.status}</span></td>
                  <td className="row">
                    {t.status === "pending" && <button className="btn" onClick={async () => { await api.updateTenant(t.id, { status: "active" }); refresh(); }}>Mark paid</button>}
                    <button className="btn-outline" onClick={async () => { if (confirm(`Delete ${t.business_name}? This can't be undone.`)) { await api.deleteTenant(t.id); refresh(); } }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "pricing" && (
        <div className="stack">
          <div className="card wrap">
            {["day", "week", "month", "year"].map((k) => (
              <label key={k} className="stack" style={{ gap: 4 }}>
                <span className="muted">{PLAN_LABELS[k]} (per location)</span>
                <input className="input" style={{ width: 100 }} type="number" value={pricing[k]}
                  onChange={(e) => setPricing((p) => ({ ...p, [k]: Number(e.target.value) }))} />
              </label>
            ))}
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Custom (per location/day)</span>
              <input className="input" style={{ width: 100 }} type="number" value={pricing.customDailyRate}
                onChange={(e) => setPricing((p) => ({ ...p, customDailyRate: Number(e.target.value) }))} />
            </label>
            <button className="btn" onClick={async () => { await api.putPricing(pricing); refresh(); }}>Save pricing</button>
            <div className="muted" style={{ fontSize: 11, width: "100%" }}>Applies to new sign-ups immediately. Existing customers keep the price they signed up at.</div>
          </div>

          <div className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Sale</div>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={pricing.sale?.active || false}
                  onChange={(e) => setPricing((p) => ({ ...p, sale: { ...p.sale, active: e.target.checked } }))} />
                <span className="muted" style={{ fontSize: 12 }}>Sale active</span>
              </label>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              Manual only — no scheduling or automatic expiry. Leave a plan's discount price blank to leave it at full price.
              Shown on the marketing page (and charged) whenever "Sale active" is on.
            </div>
            <div className="wrap">
              {["day", "week", "month", "year"].map((k) => (
                <label key={k} className="stack" style={{ gap: 4 }}>
                  <span className="muted">{PLAN_LABELS[k]} sale price</span>
                  <input className="input" style={{ width: 100 }} type="number" placeholder="—"
                    value={pricing.sale?.[k] ?? ""}
                    onChange={(e) => setPricing((p) => ({ ...p, sale: { ...p.sale, [k]: e.target.value === "" ? null : Number(e.target.value) } }))} />
                </label>
              ))}
            </div>
            <div><button className="btn" onClick={async () => { await api.putPricing(pricing); refresh(); }}>Save sale</button></div>
          </div>
        </div>
      )}

      {tab === "testing" && <ClockPanel setError={setError} />}
    </div>
  );
}

function ClockPanel({ setError }) {
  const [clock, setClock] = useState(null);
  const [draft, setDraft] = useState("");

  async function load() {
    try { const r = await api.getClock(); setClock(r); setDraft(r.today); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function apply() {
    try { const r = await api.setClock(draft); setClock(r); } catch (err) { setError(err.message); }
  }
  async function reset() {
    try { const r = await api.resetClock(); setClock(r); setDraft(r.today); } catch (err) { setError(err.message); }
  }

  return (
    <div className="card stack" style={{ maxWidth: 420 }}>
      <div style={{ fontSize: 13 }}>
        Simulated "today" for testing date-locking, plan windows, etc. — affects every app
        (marketing, admin portal, staff kiosk) since it's set on the server.
      </div>
      {clock && (
        <div className="row">
          <span className="muted">Currently:</span>
          <strong>{clock.today}</strong>
          <span className={`badge badge-${clock.simulated ? "amber" : "green"}`}>{clock.simulated ? "simulated" : "real date"}</span>
        </div>
      )}
      <div className="row">
        <input className="input" type="date" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" onClick={apply}>Set date</button>
      </div>
      {clock?.simulated && <button className="btn-outline" onClick={reset}>Reset to real date</button>}
    </div>
  );
}
