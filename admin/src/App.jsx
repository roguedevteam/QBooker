import { useState, useEffect, useRef } from "react";
import { priceText, exMoney as gbp } from "./lib/vat.js";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from "recharts";
import { api, setToken, hasToken, onSessionEnded } from "./lib/api.js";

const PLAN_LABELS = { day: "Day", week: "Week", month: "Month", year: "Year", custom: "Custom" };
const LICENSE_STATUS_META = {
  available: { label: "Available", color: "amber" },
  scheduled: { label: "Scheduled", color: "blue" },
  active: { label: "Active", color: "green" },
  expired: { label: "Expired", color: "red" },
  refunded: { label: "Refunded", color: "red" },
};

const TAB_TITLES = { dashboard: "Dashboard", customers: "Customers", pricing: "Pricing", testing: "Testing" };
const TABS = ["dashboard", "customers", "pricing", "testing"];

function BackIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
  );
}
function DotsIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
  );
}
const NAV_PATHS = {
  dashboard: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  customers: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5a3.5 3.5 0 010 7M18 14c2 .6 3.5 2.4 3.5 6" /></>,
  pricing: <><path d="M3 12l9-9h8v8l-9 9z" /><circle cx="15.5" cy="8.5" r="1.3" /></>,
  testing: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  signout: <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />,
};
function NavIcon({ name }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{NAV_PATHS[name]}</svg>
  );
}

// Small "More" (three-dots) popover menu: items are 44px tall; closes on outside click, Escape or choice.
function MoreMenu({ items, label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <span className="menu-wrap" ref={ref}>
      <button type="button" className="btn-outline icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <DotsIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function statusBadgeClass(status) { return status === "active" ? "green" : status === "disabled" ? "red" : "amber"; }

// Shared logo mark — a steel-blue tile with an amber "notch", plus the wordmark.
// Address is stored as one "line1, line2, city, postcode" string on tenants.company_address
// (same column customer-admin's own Profile tab edits) — these mirror customer-admin's
// split/combine helpers so support sees and edits the same four fields.
// Deleting a customer is permanent and wipes their locations/services/licenses/history (a
// revenue summary is kept, but everything else is gone) — require typing DELETE rather than
// a single confirm(), matching the same safeguard on the tenant's own self-service deletion.
function confirmDeleteCustomer(businessName) {
  const typed = prompt(
    `This permanently deletes "${businessName}" — every location, service, license and booking history goes with it. This can't be undone.\n\nType DELETE to confirm.`
  );
  return typed === "DELETE";
}

function splitAddress(combined) {
  const parts = (combined || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 4) return { line1: parts[0], line2: parts[1], city: parts[2], postcode: parts[3] };
  if (parts.length === 3) return { line1: parts[0], line2: "", city: parts[1], postcode: parts[2] };
  if (parts.length === 2) return { line1: parts[0], line2: "", city: "", postcode: parts[1] };
  if (parts.length === 1) return { line1: parts[0], line2: "", city: "", postcode: "" };
  return { line1: "", line2: "", city: "", postcode: "" };
}
function combineAddress(line1, line2, city, postcode) {
  return [line1, line2, city, postcode].map((s) => (s || "").trim()).filter(Boolean).join(", ");
}

function AddressFields({ tenantId, companyAddress, onSaved, setError }) {
  const initial = splitAddress(companyAddress);
  const [line1, setLine1] = useState(initial.line1);
  const [line2, setLine2] = useState(initial.line2);
  const [city, setCity] = useState(initial.city);
  const [postcode, setPostcode] = useState(initial.postcode);

  async function save() {
    const combined = combineAddress(line1, line2, city, postcode);
    if (combined === (companyAddress || "")) return;
    try {
      await api.updateTenant(tenantId, { companyAddress: combined });
      onSaved();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <label className="field span2">
        <span className="field-label">Address line 1</span>
        <input className="input" autoComplete="off" value={line1} onChange={(e) => setLine1(e.target.value)} onBlur={save} />
      </label>
      <label className="field span2">
        <span className="field-label">Address line 2</span>
        <input className="input" autoComplete="off" value={line2} onChange={(e) => setLine2(e.target.value)} onBlur={save} />
      </label>
      <label className="field">
        <span className="field-label">City</span>
        <input className="input" autoComplete="off" value={city} onChange={(e) => setCity(e.target.value)} onBlur={save} />
      </label>
      <label className="field">
        <span className="field-label">Post / zip code</span>
        <input className="input" autoComplete="off" value={postcode} onChange={(e) => setPostcode(e.target.value)} onBlur={save} />
      </label>
    </>
  );
}

function Logo({ size = 28, dark = false }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
        <rect x="2" y="2" width="40" height="40" fill="var(--accent)" />
        <circle cx="42" cy="22" r="7" fill="var(--blue)" />
      </svg>
      <span className={dark ? "logo-word logo-word-light" : "logo-word"}>QBooker</span>
    </span>
  );
}

export default function App() {
  const [signedIn, setSignedIn] = useState(hasToken());
  const [error, setError] = useState("");

  // The server says the token is expired / not a system-admin one: back to the sign-in screen with the reason.
  useEffect(() => { onSessionEnded((msg) => { setSignedIn(false); setError(msg); }); return () => onSessionEnded(null); }, []);

  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} setError={setError} error={error} />;
  return <Dashboard setError={setError} error={error} onSignOut={() => { setToken(null); setError(""); setSignedIn(false); }} />;
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
    <div className="login-wrap">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (!submitting) submit(); }}>
        <div className="row" style={{ marginBottom: 4 }}><Logo /></div>
        <h1>System Admin</h1>
        <p className="muted small" style={{ margin: 0 }}>Platform team only. Not linked from the customer-facing site.</p>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="btn btn-accent" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
        {error && <div role="alert" style={{ color: "var(--error)", fontSize: 14 }}>{error}</div>}
      </form>
    </div>
  );
}

function Dashboard({ setError, error, onSignOut }) {
  const [tab, setTab] = useState("dashboard");
  const [tenants, setTenants] = useState([]);
  const [viewingTenantId, setViewingTenantId] = useState(null);
  const [pricing, setPricing] = useState(null); // the saved price table, as customers see it (null until loaded)
  const [overview, setOverview] = useState(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerStatusFilter, setCustomerStatusFilter] = useState("all"); // all | unpaid | pending | enabled | disabled

  async function refresh() {
    try {
      const [t, p, o] = await Promise.all([api.getTenants(), api.getPricing(), api.getReportsOverview()]);
      setTenants(t.tenants);
      setPricing(p.pricing);
      setOverview(o);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { refresh(); }, []);

  const filteredTenants = tenants.filter((t) => {
    const q = customerSearch.trim().toLowerCase();
    if (q && !t.business_name?.toLowerCase().includes(q) && !t.email?.toLowerCase().includes(q)) return false;
    if (customerStatusFilter === "disabled" && t.status !== "disabled") return false;
    if (customerStatusFilter === "enabled" && t.status === "disabled") return false;
    if (customerStatusFilter === "pending" && t.status !== "pending") return false;
    if (customerStatusFilter === "unpaid" && !(Number(t.unpaid_count) > 0)) return false;
    return true;
  });

  const chartData = overview
    ? Object.entries(overview.revenueByPlan).map(([planId, revenue]) => ({ name: PLAN_LABELS[planId] || planId, Revenue: revenue }))
    : [];

  // A failed row action (e.g. the customer was deleted in another window) is reported, never swallowed.
  async function rowAction(fn) {
    setError("");
    try { await fn(); } catch (err) { setError(err.message); }
    await refresh();
  }
  const enableTenant = (t) => rowAction(() => api.updateTenant(t.id, { status: "active" }));
  const disableTenant = (t) => {
    if (confirm(`Disable "${t.business_name}"? They won't be able to sign in to anything — admin, staff, or customer WhatsApp — until you re-enable the account.`)) {
      return rowAction(() => api.updateTenant(t.id, { status: "disabled" }));
    }
  };
  const deleteTenantRow = (t) => { if (confirmDeleteCustomer(t.business_name)) return rowAction(() => api.deleteTenant(t.id)); };

  // Switching tabs re-reads the platform's figures and customers (sign-ups and payments keep arriving while the
  // console is open) and drops any stale error message.
  function goTab(t) {
    if (t === "customers" && tab === "customers" && viewingTenantId) setViewingTenantId(null);
    setError("");
    if (t === "dashboard" || t === "customers") refresh();
    setTab(t);
  }
  const unpaidTenants = tenants.filter((t) => Number(t.unpaid_count) > 0);
  const filterCounts = {
    all: tenants.length,
    unpaid: unpaidTenants.length,
    pending: tenants.filter((t) => t.status === "pending").length,
    enabled: tenants.filter((t) => t.status !== "disabled").length,
    disabled: tenants.filter((t) => t.status === "disabled").length,
  };

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <div className="side-brand">
          <div className="eyebrow">QBooker</div>
          <div className="name">System admin</div>
        </div>
        <nav aria-label="Main">
          {TABS.map((t) => (
            <button key={t} type="button" className={`side-link${tab === t ? " active" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => goTab(t)}>
              <NavIcon name={t} />{TAB_TITLES[t]}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button type="button" className="side-link" onClick={onSignOut}><NavIcon name="signout" />Sign out</button>
      </aside>

      <div style={{ minWidth: 0 }}>
        <header className="app-header is-admin">
          <div className="grow">
            <div className="eyebrow">QBooker</div>
            <div className="name">System admin</div>
          </div>
          <button type="button" className="signout" onClick={onSignOut}>Sign out</button>
        </header>

        <main className="shell-main stack" style={{ gap: 16 }}>
          {error && <div className="err-banner" role="alert"><span className="grow">{error}</span><button type="button" className="btn-outline" onClick={() => setError("")}>Dismiss</button></div>}

          {!(tab === "customers" && viewingTenantId) && (
            <div className="page-head"><h1>{TAB_TITLES[tab]}</h1></div>
          )}

          {tab === "dashboard" && !overview && !error && <div className="card muted">Loading…</div>}
          {tab === "dashboard" && overview && (
            <div className="stack" style={{ gap: 16 }}>
              <section className="stat-grid" aria-label="Key figures">
                <div className="stat"><div className="stat-num">{gbp(overview.totalRevenue)}</div><div className="stat-label">Revenue, ex VAT (active)</div></div>
                <div className="stat"><div className="stat-num warn">{gbp(overview.pendingRevenue)}</div><div className="stat-label">Pending invoices, ex VAT</div></div>
                <div className="stat"><div className="stat-num">{overview.customerCount}</div><div className="stat-label">Customers</div></div>
                <div className="stat"><div className="stat-num">{overview.totalLocations}</div><div className="stat-label">Locations, all customers</div></div>
              </section>

              {unpaidTenants.length > 0 && (
                <div className="alert-strip">
                  <div className="alert-row">
                    <span><strong>{unpaidTenants.length} customer{unpaidTenants.length === 1 ? "" : "s"}</strong> {unpaidTenants.length === 1 ? "has" : "have"} unpaid licences</span>
                    <button type="button" className="btn btn-accent" onClick={() => { setCustomerStatusFilter("unpaid"); setCustomerSearch(""); setViewingTenantId(null); setTab("customers"); }}>Review</button>
                  </div>
                </div>
              )}

              <section className="card stack" aria-labelledby="rev-plan">
                <h2 id="rev-plan">Revenue by plan type, ex VAT (active customers)</h2>
                {chartData.length > 0 ? (
                  <div className="chart-wrap" style={{ height: Math.max(160, chartData.length * 56 + 30) }} role="img" aria-label={`Revenue by plan: ${chartData.map((d) => `${d.name} ${gbp(d.Revenue)}`).join(", ")}`}>
                    <ResponsiveContainer>
                      <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E1E1DB" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 13 }} tickFormatter={(v) => `£${v}`} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 14 }} width={64} />
                        <Tooltip formatter={(v) => gbp(v)} cursor={{ fill: "#EEEEE9" }} />
                        <Bar dataKey="Revenue" fill="#1D5C8A" radius={[0, 0, 0, 0]}>
                          <LabelList dataKey="Revenue" position="right" formatter={(v) => gbp(v)} style={{ fontSize: 13, fontWeight: 600 }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="muted" style={{ textAlign: "center", padding: 20 }}>No active customers yet.</div>
                )}
              </section>

              {overview.deletedCustomerCount > 0 && (
                <div className="muted small">
                  Includes {gbp(overview.deletedRevenue)} (ex VAT) from {overview.deletedCustomerCount} deleted customer{overview.deletedCustomerCount === 1 ? "" : "s"} — retained as an anonymised revenue record (no name/email/address) when their account was deleted.
                </div>
              )}
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
            <div className="stack" style={{ gap: 12 }}>
              <div className="toolbar">
                <label className="field" style={{ flex: "none" }}>
                  <span className="sr-only">Search customers</span>
                  <input
                    className="input search" type="search"
                    placeholder="Search business or email…"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                  />
                </label>
                <div className="chips" role="group" aria-label="Filter customers">
                  {[
                    { id: "all", label: "All" },
                    { id: "unpaid", label: "Unpaid" },
                    { id: "pending", label: "Pending" },
                    { id: "enabled", label: "Enabled" },
                    { id: "disabled", label: "Disabled" },
                  ].map((f) => (
                    <button
                      key={f.id} type="button"
                      className={`chip${customerStatusFilter === f.id ? " on" : ""}`}
                      aria-pressed={customerStatusFilter === f.id}
                      onClick={() => setCustomerStatusFilter(f.id)}
                    >
                      {f.label} {filterCounts[f.id]}
                    </button>
                  ))}
                </div>
              </div>

              {filteredTenants.length === 0 && (
                <div className="card muted" style={{ textAlign: "center", padding: 20 }}>{tenants.length === 0 ? "No customers yet." : "No customers match your search."}</div>
              )}

              {filteredTenants.length > 0 && (
                <>
                  <div className="stack show-narrow" style={{ gap: 12 }}>
                    {filteredTenants.map((t) => (
                      <div key={t.id} className="cust-card">
                        <button type="button" className="cust-open" onClick={() => setViewingTenantId(t.id)} aria-label={`Open ${t.business_name}`}>
                          <span className="cust-name">{t.business_name}</span>
                          <span className={`badge badge-${statusBadgeClass(t.status)}`}>{t.status}</span>
                        </button>
                        <div className="small muted" style={{ overflowWrap: "anywhere" }}>
                          {t.email}{t.signup_country ? ` · ${t.signup_country}` : ""}
                        </div>
                        <div className="cust-meta">
                          <span>{t.location_count} location{Number(t.location_count) === 1 ? "" : "s"}</span>
                          <span>{t.service_count} service{Number(t.service_count) === 1 ? "" : "s"}</span>
                          <span className="mono">{gbp(t.total_spend)}</span>
                        </div>
                        <div className="wrap" style={{ gap: 8 }}>
                          {t.signup_country && t.signup_country !== "GB" && <span className="badge badge-amber" title="Signed up from outside the UK — worth a second look">Outside UK: {t.signup_country}</span>}
                          {Number(t.unpaid_count) > 0 && <span className="badge badge-amber">{t.unpaid_count} unpaid</span>}
                          <span className="grow" />
                          <button type="button" className="btn" onClick={() => setViewingTenantId(t.id)}>View</button>
                          <MoreMenu label={`More actions for ${t.business_name}`} items={[
                            t.status === "disabled"
                              ? { label: "Enable", onClick: () => enableTenant(t) }
                              : { label: "Disable", danger: true, onClick: () => disableTenant(t) },
                            { label: "Delete", danger: true, onClick: () => deleteTenantRow(t) },
                          ]} />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="table-card show-wide">
                    <table>
                      <thead><tr><th>Business</th><th>Email</th><th>Country</th><th>Services</th><th>Locations</th><th>Licence spend, ex VAT</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {filteredTenants.map((t) => (
                          <tr key={t.id}>
                            <td><button type="button" className="link-btn" onClick={() => setViewingTenantId(t.id)}>{t.business_name}</button></td>
                            <td style={{ overflowWrap: "anywhere" }}>{t.email}</td>
                            <td>
                              {t.signup_country
                                ? <span className={t.signup_country === "GB" ? "muted" : "badge badge-amber"} title={t.signup_country !== "GB" ? "Signed up from outside the UK — worth a second look" : undefined}>{t.signup_country}</span>
                                : <span className="muted">—</span>}
                            </td>
                            <td>{t.service_count}</td>
                            <td>{t.location_count}</td>
                            <td className="num">{gbp(t.total_spend)}</td>
                            <td>
                              <span className={`badge badge-${statusBadgeClass(t.status)}`}>{t.status}</span>
                              {Number(t.unpaid_count) > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }} title="Invoice licenses awaiting payment — open the customer to mark them paid">{t.unpaid_count} unpaid</span>}
                            </td>
                            <td>
                              <div className="row-actions">
                                <button type="button" className="btn-outline" onClick={() => setViewingTenantId(t.id)}>View</button>
                                {t.status === "disabled"
                                  ? <button type="button" className="btn-outline" onClick={() => enableTenant(t)}>Enable</button>
                                  : <button type="button" className="btn-outline danger" onClick={() => disableTenant(t)}>Disable</button>}
                                <button type="button" className="btn-outline danger" onClick={() => deleteTenantRow(t)}>Delete</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "pricing" && !pricing && !error && <div className="card muted">Loading…</div>}
          {tab === "pricing" && pricing && <PricingPanel pricing={pricing} onSaved={refresh} setError={setError} />}

          {tab === "testing" && <ClockPanel setError={setError} />}
        </main>

        <nav className="bottom-nav" aria-label="Main">
          {TABS.map((t) => (
            <button key={t} type="button" className={tab === t ? "active" : undefined} aria-current={tab === t ? "page" : undefined} onClick={() => goTab(t)}>
              <NavIcon name={t} />{TAB_TITLES[t]}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

// Plan prices and the sale. The boxes hold what is typed (text), so a cleared box is "missing", never silently 0;
// each Save button sends only its own section and the server re-checks everything.
const PLAN_KEYS = ["day", "week", "month", "year"];
const toBox = (v) => (v === null || v === undefined ? "" : String(v));
function parseAmount(text, label, { blankOk = false } = {}) {
  const t = String(text).trim();
  if (t === "") { if (blankOk) return null; throw new Error(`Enter a price for ${label}.`); }
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

function PricingPanel({ pricing, onSaved, setError }) {
  const [prices, setPrices] = useState(() => ({ day: toBox(pricing.day), week: toBox(pricing.week), month: toBox(pricing.month), year: toBox(pricing.year), customDailyRate: toBox(pricing.customDailyRate) }));
  const [saleActive, setSaleActive] = useState(!!pricing.sale?.active);
  const [salePrices, setSalePrices] = useState(() => Object.fromEntries(PLAN_KEYS.map((k) => [k, toBox(pricing.sale?.[k])])));
  const [saving, setSaving] = useState("");
  const [saved, setSaved] = useState("");

  async function save(which) {
    setError(""); setSaved("");
    setSaving(which);
    try {
      let body;
      if (which === "prices") {
        body = { customDailyRate: parseAmount(prices.customDailyRate, "Custom (per location/day)") };
        for (const k of PLAN_KEYS) body[k] = parseAmount(prices[k], `${PLAN_LABELS[k]} (per location)`);
      } else {
        const sale = { active: saleActive };
        for (const k of PLAN_KEYS) sale[k] = parseAmount(salePrices[k], `${PLAN_LABELS[k]} sale price`, { blankOk: true });
        body = { sale };
      }
      await api.putPricing(body);
      setSaved(which);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted small" style={{ margin: 0 }}>Enter prices without VAT. Customers see the VAT-inclusive amount (20%) in brackets.</p>
      <section className="card stack" aria-labelledby="plan-prices">
        <h2 id="plan-prices">Plan prices</h2>
        <div className="price-grid">
          {PLAN_KEYS.map((k) => (
            <label key={k} className="field">
              <span className="field-label">{PLAN_LABELS[k]} (per location)</span>
              <input className="input" type="number" min={0} step="0.01" inputMode="decimal" value={prices[k]}
                onChange={(e) => { setSaved(""); setPrices((p) => ({ ...p, [k]: e.target.value })); }} />
            </label>
          ))}
          <label className="field">
            <span className="field-label">Custom (per location/day)</span>
            <input className="input" type="number" min={0} step="0.01" inputMode="decimal" value={prices.customDailyRate}
              onChange={(e) => { setSaved(""); setPrices((p) => ({ ...p, customDailyRate: e.target.value })); }} />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" disabled={!!saving} onClick={() => save("prices")}>{saving === "prices" ? "Saving…" : "Save pricing"}</button>
          {saved === "prices" && <span role="status" className="muted small">Saved — new sign-ups pay these prices now.</span>}
        </div>
        <div className="field-hint">Applies to new sign-ups immediately. Existing customers keep the price they signed up at.</div>
      </section>

      <section className="card stack" aria-labelledby="sale-h">
        <div className="row spread">
          <h2 id="sale-h">Sale</h2>
          <label className="checkbox-row">
            <input type="checkbox" checked={saleActive} onChange={(e) => { setSaved(""); setSaleActive(e.target.checked); }} />
            <span>Sale active</span>
          </label>
        </div>
        <div className="field-hint">
          Manual only — no scheduling or automatic expiry. Leave a plan's discount price blank to leave it at full price.
          Shown on the marketing page (and charged) whenever "Sale active" is on.
        </div>
        <div className="price-grid four">
          {PLAN_KEYS.map((k) => (
            <label key={k} className="field">
              <span className="field-label">{PLAN_LABELS[k]} sale price</span>
              <input className="input" type="number" min={0} step="0.01" inputMode="decimal" placeholder="—" value={salePrices[k]}
                onChange={(e) => { setSaved(""); setSalePrices((p) => ({ ...p, [k]: e.target.value })); }} />
            </label>
          ))}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" disabled={!!saving} onClick={() => save("sale")}>{saving === "sale" ? "Saving…" : "Save sale"}</button>
          {saved === "sale" && <span role="status" className="muted small">Saved — the sale is {saleActive ? "on" : "off"}.</span>}
        </div>
      </section>
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

  if (!open) return <button type="button" className="btn-outline" onClick={() => setOpen(true)}>+ Free license</button>;
  return (
    <div className="inline-form" role="group" aria-label={`Grant free license on ${service.name}`}>
      <label className="field">
        <span className="field-label">Plan</span>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
          {["day", "week", "month", "year", "custom"].map((id) => (
            <option key={id} value={id}>{PLAN_LABELS[id]}</option>
          ))}
        </select>
      </label>
      {planId === "custom" && (
        <label className="field">
          <span className="field-label">Days</span>
          <input
            className="input" type="number" min={1} inputMode="numeric" value={customDays}
            onChange={(e) => setCustomDays(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      )}
      <div className="form-actions">
        <button type="button" className="btn" disabled={granting} onClick={grant}>{granting ? "Granting…" : "Grant"}</button>
        <button type="button" className="btn-outline" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// Staff users on this customer's account — platform admin can correct or remove them.
function StaffUsers({ tenantId, staff, onChanged, setError }) {
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ firstName: "", lastName: "", email: "" });
  async function save(id) {
    try { await api.updateTenantStaff(tenantId, id, edit); setEditId(null); onChanged(); } catch (err) { setError(err.message); }
  }
  async function remove(m) {
    if (!confirm(`Remove ${m.first_name} ${m.last_name} from this account? They'll be signed out of the staff portal.`)) return;
    try { await api.deleteTenantStaff(tenantId, m.id); onChanged(); } catch (err) { setError(err.message); }
  }
  return (
    <section className="stack" style={{ gap: 10 }} aria-labelledby="staff-h">
      <h2 id="staff-h">Staff users ({staff.length})</h2>
      <div className="card">
        {staff.length === 0 && <div className="muted" style={{ textAlign: "center", padding: 8 }}>No staff users on this account.</div>}
        {staff.map((m) => editId === m.id ? (
          <div key={m.id} className="staff-card">
            <div className="form-grid">
              <label className="field">
                <span className="field-label">First name</span>
                <input className="input" value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Last name</span>
                <input className="input" value={edit.lastName} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} />
              </label>
              <label className="field span2">
                <span className="field-label">Email</span>
                <input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
              </label>
            </div>
            <div className="form-actions">
              <button type="button" className="btn" disabled={!edit.firstName.trim() || !edit.lastName.trim() || !edit.email.trim()} onClick={() => save(m.id)}>Save</button>
              <button type="button" className="btn-outline" onClick={() => setEditId(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div key={m.id} className="staff-card">
            <div className="list-row">
              <div className="grow">
                <div style={{ fontSize: 15, fontWeight: 600 }}>{m.first_name} {m.last_name}</div>
                <div className="small muted" style={{ overflowWrap: "anywhere" }}>{m.email}</div>
              </div>
              <div className="row">
                <button type="button" className="btn-outline" aria-label={`Edit ${m.first_name} ${m.last_name}`} onClick={() => { setEditId(m.id); setEdit({ firstName: m.first_name, lastName: m.last_name, email: m.email }); }}>Edit</button>
                <button type="button" className="btn-outline danger" aria-label={`Delete ${m.first_name} ${m.last_name}`} onClick={() => remove(m)}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddAnnualLicense({ tenantId, service, onAdded, setError }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  async function add() {
    try {
      await api.addAnnualLicense(tenantId, service.id, { price: Number(price) });
      setOpen(false); setPrice("");
      onAdded();
    } catch (err) { setError(err.message); }
  }
  if (!open) return <button type="button" className="btn-outline" onClick={() => setOpen(true)}>+ Annual license</button>;
  return (
    <div className="inline-form" role="group" aria-label={`Add annual license on ${service.name}`}>
      <label className="field">
        <span className="field-label">Agreed price £ (ex VAT)</span>
        <input className="input" type="number" min={1} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" disabled={!(Number(price) > 0)} onClick={add}>Add</button>
        <button type="button" className="btn-outline" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function RefundLicenseButton({ tenantId, service, license, onRefunded, setError }) {
  const refundable = (license.status === "available" || license.status === "scheduled") && !(license.payment_method === "later" && license.paid === false);
  if (!refundable) return null;
  return (
    <button
      type="button"
      className="btn-outline"
      aria-label={`Refund ${license.plan_label} license on ${service.name}`}
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [rev, setRev] = useState(0); // bumped after a rejected edit so the boxes go back to the stored values

  async function load() {
    try {
      const r = await api.getTenantDetail(tenantId);
      setDetail(r);
      setLoadFailed(false);
    } catch (err) {
      setError(err.message);
      setLoadFailed(true);
    }
  }
  useEffect(() => { setDetail(null); setLoadFailed(false); load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run a change, report a refusal in the banner (never swallow it), then show what's really stored.
  async function act(fn) {
    setError("");
    try { await fn(); } catch (err) { setError(err.message); setRev((r) => r + 1); }
    await load();
  }

  if (!detail && loadFailed) {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <div className="page-head"><div className="subhead grow">
          <button type="button" className="back-btn" aria-label="Back to all customers" onClick={onBack}><BackIcon /></button>
          <h1>Customer</h1>
        </div></div>
        <div className="card muted">This customer couldn't be loaded. Go back to the list and try again.</div>
      </div>
    );
  }
  if (!detail) return <div className="card muted">Loading…</div>;
  const { tenant, locations, services, licenses, staff = [] } = detail;
  const servicesByLocation = (locId) => services.filter((s) => s.location_id === locId);
  const licensesByService = (svcId) => licenses.filter((l) => l.service_id === svcId);

  const unpaidBlocking = licenses.some((l) => l.paid === false && l.status !== "refunded");

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div className="subhead grow">
          <button type="button" className="back-btn" aria-label="Back to all customers" onClick={onBack}><BackIcon /></button>
          <h1 style={{ overflowWrap: "anywhere" }}>{tenant.business_name}</h1>
        </div>
        <span className={`badge badge-${statusBadgeClass(tenant.status)}`}>
          {tenant.status === "pending" ? "Payment pending" : tenant.status === "disabled" ? "Disabled" : "Active"}
        </span>
      </div>

      <section className="card stack" aria-labelledby="acct-h">
        <h2 id="acct-h">Account</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">First name</span>
            <input
              key={`fn${rev}`} className="input" defaultValue={tenant.first_name || ""}
              onBlur={(e) => { if (e.target.value !== (tenant.first_name || "")) act(() => api.updateTenant(tenant.id, { firstName: e.target.value })); }}
            />
          </label>
          <label className="field">
            <span className="field-label">Last name</span>
            <input
              key={`ln${rev}`} className="input" defaultValue={tenant.last_name || ""}
              onBlur={(e) => { if (e.target.value !== (tenant.last_name || "")) act(() => api.updateTenant(tenant.id, { lastName: e.target.value })); }}
            />
          </label>
          <label className="field">
            <span className="field-label">Business name</span>
            <input
              key={`bn${rev}`} className="input" defaultValue={tenant.business_name}
              onBlur={(e) => { if (e.target.value !== (tenant.business_name)) act(() => api.updateTenant(tenant.id, { businessName: e.target.value })); }}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              key={`em${rev}`} className="input" type="email" defaultValue={tenant.email}
              onBlur={(e) => { if (e.target.value !== (tenant.email)) act(() => api.updateTenant(tenant.id, { email: e.target.value })); }}
            />
          </label>
          <label className="field">
            <span className="field-label">Location count (billing)</span>
            <input
              key={`lc${rev}`} className="input" type="number" inputMode="numeric" defaultValue={tenant.location_count}
              onBlur={(e) => { if (Number(e.target.value) !== tenant.location_count) act(() => api.updateTenant(tenant.id, { locationCount: e.target.value === "" ? "" : Number(e.target.value) })); }}
            />
          </label>
          <div className="field">
            <span className="field-label">Signed up from</span>
            <span style={{ minHeight: 40, display: "flex", alignItems: "center" }}>
              {tenant.signup_country
                ? <span className={tenant.signup_country === "GB" ? undefined : "badge badge-amber"}>{tenant.signup_country}{tenant.signup_country !== "GB" ? " — outside the UK" : ""}</span>
                : <span className="muted">Unknown</span>}
            </span>
          </div>
          <AddressFields key={tenant.id} tenantId={tenant.id} companyAddress={tenant.company_address} onSaved={load} setError={setError} />
        </div>
        <div className="form-actions">
          {tenant.status === "pending" && !unpaidBlocking && <button type="button" className="btn btn-accent" onClick={() => act(() => api.updateTenant(tenant.id, { status: "active" }))}>Activate account</button>}
          {tenant.status === "disabled"
            ? <button type="button" className="btn-outline" onClick={() => act(() => api.updateTenant(tenant.id, { status: "active" }))}>Enable account</button>
            : <button type="button" className="btn-outline danger" onClick={() => { if (confirm(`Disable "${tenant.business_name}"? They won't be able to sign in to anything — admin, staff, or customer WhatsApp — until you re-enable the account.`)) act(() => api.updateTenant(tenant.id, { status: "disabled" })); }}>Disable account</button>}
          <button
            type="button"
            className="btn-outline danger"
            onClick={async () => {
              if (!confirmDeleteCustomer(tenant.business_name)) return;
              setError("");
              try { await api.deleteTenant(tenant.id); onBack(); } catch (err) { setError(err.message); }
            }}
          >
            Delete customer
          </button>
        </div>
      </section>

      <StaffUsers tenantId={tenant.id} staff={staff} onChanged={load} setError={setError} />

      <div className="stack" style={{ gap: 2 }}>
        <h2>Locations, services &amp; licenses</h2>
        <div className="muted small">{locations.length} location{locations.length === 1 ? "" : "s"}</div>
      </div>
      {locations.length === 0 && <div className="card muted">No locations yet.</div>}

      {locations.map((loc) => (
        <section key={loc.id} className="loc-block" aria-label={`Location ${loc.name}`}>
          <div className="wrap" style={{ justifyContent: "space-between", gap: 8 }}>
            <div className="row grow" style={{ flexWrap: "wrap" }}>
              <label className="grow" style={{ minWidth: 160 }}>
                <span className="sr-only">Location name</span>
                <input
                  key={`loc${rev}`} className="input" style={{ fontWeight: 600 }} defaultValue={loc.name}
                  onBlur={(e) => { if (e.target.value !== loc.name) act(() => api.updateTenantLocation(tenant.id, loc.id, { name: e.target.value })); }}
                />
              </label>
              {loc.code && <code className="badge badge-grey">{loc.code}</code>}
            </div>
            <button
              type="button"
              className="btn-outline danger"
              onClick={() => { if (confirm(`Delete location "${loc.name}"? This deletes its services and licenses too — can't be undone.`)) act(() => api.deleteTenantLocation(tenant.id, loc.id)); }}
            >
              Delete location
            </button>
          </div>

          <div className="stack" style={{ gap: 12 }}>
            {servicesByLocation(loc.id).length === 0 && <div className="muted small">No services at this location.</div>}
            {servicesByLocation(loc.id).map((svc) => {
              const svcLicenses = licensesByService(svc.id);
              const lockTitle = "Locked — this service has a license that's been scheduled, active or expired, or a day with hours already set.";
              return (
                <div key={svc.id} className="svc-block">
                  <div className="wrap" style={{ gap: 10 }}>
                    <strong style={{ fontSize: 16 }}>{svc.name}</strong>
                    {svc.archived && <span className="badge badge-amber">Archived</span>}
                  </div>
                  <div className="form-grid">
                    <label className="field">
                      <span className="field-label">Type</span>
                      <select
                        value={svc.mode} disabled={svc.modeLocked} title={svc.modeLocked ? lockTitle : undefined}
                        onChange={(e) => act(() => api.updateTenantService(tenant.id, svc.id, { mode: e.target.value }))}
                      >
                        {["queue", "appointment", "hybrid"].map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </label>
                    {svc.mode !== "queue" && (
                      <label className="field">
                        <span className="field-label">Slot length</span>
                        <select
                          value={svc.slot_minutes} disabled={svc.modeLocked}
                          title={svc.modeLocked ? lockTitle : undefined}
                          onChange={(e) => act(() => api.updateTenantService(tenant.id, svc.id, { slotMinutes: Number(e.target.value) }))}
                        >
                          {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="svc-actions">
                    <GrantFreeLicense tenantId={tenant.id} service={svc} onGranted={load} setError={setError} />
                    <AddAnnualLicense tenantId={tenant.id} service={svc} onAdded={load} setError={setError} />
                    <button type="button" className="btn-outline" onClick={() => act(() => api.updateTenantService(tenant.id, svc.id, { archived: !svc.archived }))}>
                      {svc.archived ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      type="button"
                      className="btn-outline danger"
                      onClick={() => { if (confirm(`Delete service "${svc.name}"? This deletes its licenses too — can't be undone.`)) act(() => api.deleteTenantService(tenant.id, svc.id)); }}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="lic-list">
                    {svcLicenses.length === 0 && <div className="muted small">No licenses on this service.</div>}
                    {svcLicenses.map((lic) => {
                      const meta = LICENSE_STATUS_META[lic.status] || { label: lic.status, color: "blue" };
                      const canMarkPaid = lic.paid === false && lic.payment_method !== "later" && lic.status !== "refunded";
                      return (
                        <div key={lic.id} className="lic-card">
                          <div className="lic-title">
                            <div className="grow">
                              {lic.plan_label}
                              {lic.start_date && <div className="lic-sub">{lic.start_date} to {lic.end_date}</div>}
                            </div>
                            <span className={`badge badge-${meta.color}`}>{meta.label}</span>
                          </div>
                          <div className="lic-body">
                            <span className="mono">{Number(lic.price) > 0 ? priceText(lic.price) : "Free"}</span>
                            {lic.invoice_po && <> · PO {lic.invoice_po}</>}
                            {" · "}Purchased {new Date(lic.purchased_at).toLocaleDateString()}
                          </div>
                          {Number(lic.price) > 0 && (
                            <div>
                              {lic.paid === false
                                ? <span className="badge badge-amber">{lic.payment_method === "later" ? "Pay later — unpaid" : "Invoice — unpaid"}</span>
                                : <span className="badge badge-green">{lic.payment_method === "invoice" ? "Invoice — paid" : "Paid by card"}</span>}
                            </div>
                          )}
                          <div className="lic-actions">
                            {canMarkPaid && (
                              <button type="button" className="btn btn-accent" aria-label={`Mark ${lic.plan_label} license on ${svc.name} as paid`} onClick={() => act(() => api.markLicensePaid(tenant.id, lic.id))}>Mark paid</button>
                            )}
                            <RefundLicenseButton tenantId={tenant.id} service={svc} license={lic} onRefunded={load} setError={setError} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
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
    <div className="card stack" style={{ maxWidth: 480 }}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: "21px" }}>
        Simulated "today" for testing date-locking, plan windows, etc. — affects every app
        (marketing, admin portal, staff kiosk) since it's set on the server.
      </p>
      {clock && (
        <div className="status-line">
          <span className="muted">Currently:</span>
          <strong>{clock.today}</strong>
          <span className={`badge badge-${clock.simulated ? "amber" : "green"}`}>{clock.simulated ? "simulated" : "real date"}</span>
        </div>
      )}
      <label className="field">
        <span className="field-label">Simulated date</span>
        <input className="input" type="date" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={apply}>Set date</button>
        {clock?.simulated && <button type="button" className="btn-outline" onClick={reset}>Reset to real date</button>}
      </div>
    </div>
  );
}
