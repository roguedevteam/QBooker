import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api, setToken, hasToken } from "./lib/api.js";

const PLAN_LABELS = { day: "Day", week: "Week", month: "Month", year: "Year", custom: "Custom" };
const LICENSE_STATUS_META = {
  available: { label: "Available", color: "amber" },
  scheduled: { label: "Scheduled", color: "blue" },
  active: { label: "Active", color: "green" },
  expired: { label: "Expired", color: "red" },
  refunded: { label: "Refunded", color: "red" },
};

// Shared logo mark — a steel-blue tile with an amber "notch", plus the wordmark.
function Logo({ size = 28, dark = false }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
        <rect x="2" y="2" width="40" height="40" fill="var(--blue)" />
        <circle cx="42" cy="22" r="7" fill="var(--accent)" />
      </svg>
      <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>
    </span>
  );
}

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
        <div className="row" style={{ marginBottom: 4 }}><Logo /></div>
        <h2 style={{ margin: 0 }}>System Admin</h2>
        <p className="muted" style={{ fontSize: 13 }}>Platform team only. Not linked from the customer-facing site.</p>
        <input
          className="input" type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn" disabled={submitting} onClick={submit}>{submitting ? "Signing in…" : "Sign in"}</button>
        {error && <div style={{ color: "var(--error)", fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}

function Dashboard({ setError, error, onSignOut }) {
  const [tab, setTab] = useState("dashboard");
  const [tenants, setTenants] = useState([]);
  const [viewingTenantId, setViewingTenantId] = useState(null);
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
    <div>
      <div className="header row" style={{ justifyContent: "space-between" }}>
        <Logo />
        <div className="row">
          <span className="muted" style={{ fontSize: 13 }}>System Admin</span>
          <button className="btn-outline" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      <div className="container stack">
        {error && <div className="card" style={{ borderColor: "var(--error)", color: "var(--error)" }}>{error}</div>}
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
                    <CartesianGrid strokeDasharray="3 3" stroke="#DEDDD6" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="Revenue" fill="#1D5C8A" radius={[0, 0, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {chartData.length === 0 && <div className="muted" style={{ textAlign: "center", padding: 20 }}>No active customers yet.</div>}
            </div>
          </div>
        )}

        {tab === "customers" && viewingTenantId && (
          <CustomerDetail
            tenantId={viewingTenantId}
            onBack={() => { setViewingTenantId(null); refresh(); }}
            setError={setError}
          />
        )}

        {tab === "customers" && !viewingTenantId && (
          <div className="card">
            <table>
              <thead><tr><th>Business</th><th>Email</th><th>Services</th><th>Locations</th><th>License spend</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {tenants.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: "center", padding: 20 }}>No customers yet.</td></tr>}
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button
                        className="btn-outline"
                        style={{ border: "none", padding: 0, background: "transparent", fontWeight: 600, textDecoration: "underline" }}
                        onClick={() => setViewingTenantId(t.id)}
                      >
                        {t.business_name}
                      </button>
                    </td>
                    <td>{t.email}</td>
                    <td>{t.service_count}</td>
                    <td>{t.location_count}</td>
                    <td>£{Number(t.total_spend).toFixed(2)}</td>
                    <td><span className={`badge badge-${t.status === "active" ? "green" : "amber"}`}>{t.status}</span></td>
                    <td className="row">
                      <button className="btn-outline" onClick={() => setViewingTenantId(t.id)}>View</button>
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
    </div>
  );
}

function GrantFreeLicense({ tenantId, service, onGranted, setError }) {
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState("week");
  const [customDays, setCustomDays] = useState(7);
  const [granting, setGranting] = useState(false);

  async function grant() {
    setGranting(true);
    try {
      await api.grantFreeLicense(tenantId, service.id, { planId, customDays: planId === "custom" ? customDays : undefined });
      setOpen(false);
      onGranted();
    } catch (err) {
      setError(err.message);
    } finally {
      setGranting(false);
    }
  }

  if (!open) return <button className="btn-outline" onClick={() => setOpen(true)}>+ Free license</button>;
  return (
    <span className="row" style={{ gap: 4 }}>
      <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
        {["day", "week", "month", "year", "custom"].map((id) => (
          <option key={id} value={id}>{PLAN_LABELS[id]}</option>
        ))}
      </select>
      {planId === "custom" && (
        <input
          className="input" type="number" min={1} style={{ width: 60 }} value={customDays}
          onChange={(e) => setCustomDays(Math.max(1, Number(e.target.value) || 1))}
        />
      )}
      <button className="btn" disabled={granting} onClick={grant}>{granting ? "Granting…" : "Grant"}</button>
      <button className="btn-outline" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

function RefundLicenseButton({ tenantId, service, license, onRefunded, setError }) {
  const refundable = license.status === "available" || license.status === "scheduled";
  if (!refundable) return null;
  return (
    <button
      className="btn-outline"
      onClick={async () => {
        if (!confirm(`Refund this ${license.plan_label} license on "${service.name}"? This can't be undone.`)) return;
        try {
          await api.refundTenantLicense(tenantId, service.id, license.id);
          onRefunded();
        } catch (err) {
          setError(err.message);
        }
      }}
    >
      Refund
    </button>
  );
}

// Full drill-down for one customer: account details, and locations → their services →
// each service's licenses nested together (instead of three separate flat lists you had
// to cross-reference by name) — platform support's one-stop view instead of asking the
// customer to share their screen.
function CustomerDetail({ tenantId, onBack, setError }) {
  const [detail, setDetail] = useState(null);

  async function load() {
    try {
      const r = await api.getTenantDetail(tenantId);
      setDetail(r);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) return <div className="card muted">Loading…</div>;
  const { tenant, locations, services, licenses } = detail;
  const servicesByLocation = (locId) => services.filter((s) => s.location_id === locId);
  const licensesByService = (svcId) => licenses.filter((l) => l.service_id === svcId);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button className="btn-outline" onClick={onBack}>← All customers</button>
        <span className={`badge badge-${tenant.status === "active" ? "green" : "amber"}`}>{tenant.status === "pending" ? "Payment pending" : "Active"}</span>
      </div>

      <div className="card stack">
        <div style={{ fontWeight: 600, fontSize: 14 }}>Account</div>
        {tenant.company_address && (
          <div className="muted" style={{ fontSize: 12 }}>{tenant.company_address}</div>
        )}
        <div className="wrap">
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>First name</span>
            <input
              className="input" style={{ width: 140 }} defaultValue={tenant.first_name || ""}
              onBlur={async (e) => { if (e.target.value !== (tenant.first_name || "")) { await api.updateTenant(tenant.id, { firstName: e.target.value }); load(); } }}
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Last name</span>
            <input
              className="input" style={{ width: 140 }} defaultValue={tenant.last_name || ""}
              onBlur={async (e) => { if (e.target.value !== (tenant.last_name || "")) { await api.updateTenant(tenant.id, { lastName: e.target.value }); load(); } }}
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Business name</span>
            <input
              className="input" style={{ width: 200 }} defaultValue={tenant.business_name}
              onBlur={async (e) => { if (e.target.value !== tenant.business_name) { await api.updateTenant(tenant.id, { businessName: e.target.value }); load(); } }}
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Email</span>
            <input
              className="input" style={{ width: 220 }} defaultValue={tenant.email}
              onBlur={async (e) => { if (e.target.value !== tenant.email) { await api.updateTenant(tenant.id, { email: e.target.value }); load(); } }}
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>Location count (billing)</span>
            <input
              className="input" type="number" style={{ width: 80 }} defaultValue={tenant.location_count}
              onBlur={async (e) => { if (Number(e.target.value) !== tenant.location_count) { await api.updateTenant(tenant.id, { locationCount: Number(e.target.value) }); load(); } }}
            />
          </label>
        </div>
        <div className="row">
          {tenant.status === "pending" && <button className="btn" onClick={async () => { await api.updateTenant(tenant.id, { status: "active" }); load(); }}>Mark paid</button>}
          <button
            className="btn-outline"
            onClick={async () => { if (confirm(`Delete ${tenant.business_name}? This can't be undone.`)) { await api.deleteTenant(tenant.id); onBack(); } }}
          >
            Delete customer
          </button>
        </div>
      </div>

      <div className="stack" style={{ gap: 2 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Locations, services &amp; licenses</div>
        <div className="muted" style={{ fontSize: 12 }}>{locations.length} location{locations.length === 1 ? "" : "s"}</div>
      </div>
      {locations.length === 0 && <div className="card muted" style={{ fontSize: 13 }}>No locations yet.</div>}

      {locations.map((loc) => (
        <div key={loc.id} className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>📍</span>
              <input
                className="input" style={{ width: 160, fontWeight: 600 }} defaultValue={loc.name}
                onBlur={async (e) => { if (e.target.value !== loc.name) { await api.updateTenantLocation(tenant.id, loc.id, { name: e.target.value }); load(); } }}
              />
              {loc.code && <code className="muted" style={{ fontSize: 12, background: "var(--surface-page)", padding: "2px 6px", borderRadius: 4 }}>{loc.code}</code>}
            </div>
            <button
              className="btn-outline"
              onClick={async () => { if (confirm(`Delete location "${loc.name}"? This deletes its services and licenses too — can't be undone.`)) { await api.deleteTenantLocation(tenant.id, loc.id); load(); } }}
            >
              Delete location
            </button>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            {servicesByLocation(loc.id).length === 0 && <div className="muted" style={{ fontSize: 12, padding: "0 4px" }}>No services at this location.</div>}
            {servicesByLocation(loc.id).map((svc) => {
              const svcLicenses = licensesByService(svc.id);
              const lockTitle = "Locked — this service has a license that's been scheduled, active or expired, or a day with hours already set.";
              return (
                <div key={svc.id} className="stack" style={{ gap: 8, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, padding: 12 }}>
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
                      <strong style={{ fontSize: 13 }}>{svc.name}</strong>
                      {svc.archived && <span className="badge badge-amber">Archived</span>}
                      <label className="row" style={{ gap: 4 }}>
                        <span className="muted" style={{ fontSize: 11 }}>Type:</span>
                        <select
                          value={svc.mode} disabled={svc.modeLocked} title={svc.modeLocked ? lockTitle : undefined}
                          onChange={async (e) => { await api.updateTenantService(tenant.id, svc.id, { mode: e.target.value }); load(); }}
                        >
                          {["queue", "appointment", "hybrid"].map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                      {svc.mode !== "queue" && (
                        <label className="row" style={{ gap: 4 }}>
                          <span className="muted" style={{ fontSize: 11 }}>Slot length:</span>
                          <select
                            value={svc.slot_minutes} disabled={svc.modeLocked}
                            title={svc.modeLocked ? lockTitle : undefined}
                            onChange={async (e) => { await api.updateTenantService(tenant.id, svc.id, { slotMinutes: Number(e.target.value) }); load(); }}
                          >
                            {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="row">
                      <GrantFreeLicense tenantId={tenant.id} service={svc} onGranted={load} setError={setError} />
                      <button className="btn-outline" onClick={async () => { await api.updateTenantService(tenant.id, svc.id, { archived: !svc.archived }); load(); }}>
                        {svc.archived ? "Unarchive" : "Archive"}
                      </button>
                      <button
                        className="btn-outline"
                        onClick={async () => { if (confirm(`Delete service "${svc.name}"? This can't be undone.`)) { await api.deleteTenantService(tenant.id, svc.id); load(); } }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="stack" style={{ gap: 4, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                    {svcLicenses.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No licenses on this service.</div>}
                    {svcLicenses.map((lic) => {
                      const meta = LICENSE_STATUS_META[lic.status] || { label: lic.status, color: "blue" };
                      return (
                        <div key={lic.id} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                            <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                            <span style={{ fontWeight: 600 }}>{lic.plan_label}</span>
                            {lic.start_date && <span className="muted">{lic.start_date} to {lic.end_date}</span>}
                            <span className="muted">{Number(lic.price) > 0 ? `£${lic.price}` : "Free"}</span>
                            <span className="muted">Purchased {new Date(lic.purchased_at).toLocaleDateString()}</span>
                          </div>
                          <RefundLicenseButton tenantId={tenant.id} service={svc} license={lic} onRefunded={load} setError={setError} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
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
