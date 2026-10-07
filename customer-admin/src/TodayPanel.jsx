// "Today" day ribbon. Shared component: an identical copy lives in customer-admin/src and
// staff/src (no cross-app imports) — keep the two files (and today.css) in sync.
import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./lib/api.js";
import "./today.css";

const NO_HOURS = "No hours set for today. Set them in the location's service settings.";
const NO_LICENCE = "This service isn't licensed for today. Check its licences in the location's service settings.";
const WIDE_PX = 520; // panel width at which the 30-minute ribbon replaces the hourly rows

function localMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function clock(min) { return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`; }
function fmt(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}
function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// Cells for one block (or hour): booking places first, then walk-in places. kind: b | w, state: used | free
function cellsFor(bk, bkCap, wk, wkCap) {
  const out = [];
  for (let i = 0; i < Math.max(bkCap, bk); i++) out.push({ kind: "b", used: i < bk });
  for (let i = 0; i < Math.max(wkCap, wk); i++) out.push({ kind: "w", used: i < wk });
  return out;
}
const cellClass = (c, past) => `td-cell ${c.kind === "b" ? "bk" : "wk"} ${c.used ? "used" : "free"}${past ? " past" : ""}`;

function useWide(ref) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 768);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= WIDE_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return wide;
}

function insights(blocks, nowMin) {
  const out = [];
  const byHour = new Map();
  blocks.forEach((b) => {
    const h = Math.floor(b.start / 60);
    const g = byHour.get(h) || { h, used: 0, cap: 0 };
    g.used += b.booked + b.walkIn; g.cap += b.bookingCapacity + b.walkinCapacity;
    byHour.set(h, g);
  });
  const busiest = [...byHour.values()].filter((g) => g.cap > 0 && g.used > 0).sort((a, b) => b.used / b.cap - a.used / a.cap || a.h - b.h)[0];
  if (busiest) {
    const full = busiest.used >= busiest.cap;
    out.push({ key: "busy", title: "Busiest", text: `${fmt(busiest.h * 60)} to ${fmt(busiest.h * 60 + 60)}. ${full ? "Everything is taken, so new patients will join the queue." : `${busiest.used} of ${busiest.cap} places taken.`}` });
  }
  // Longest run of upcoming blocks that are still at least 75% free for bookings.
  let best = null, run = null;
  blocks.filter((b) => b.start + 30 > nowMin && b.bookingCapacity > 0).forEach((b) => {
    const ok = (b.bookingCapacity - b.booked) / b.bookingCapacity >= 0.75;
    if (ok && run && run.end === b.start) { run.end = b.start + 30; run.free += b.bookingCapacity - b.booked; }
    else if (ok) run = { start: b.start, end: b.start + 30, free: b.bookingCapacity - b.booked };
    else run = null;
    if (run && (!best || run.end - run.start > best.end - best.start)) best = { ...run };
  });
  if (best) out.push({ key: "free", title: "Most room", text: `${fmt(best.start)} to ${fmt(best.end)}. ${best.free} booking place${best.free === 1 ? "" : "s"} still free.` });
  return out;
}

function Kpi({ num, label, tone }) {
  return <div className="td-kpi"><div className={`td-kpi-n mono${tone ? ` ${tone}` : ""}`}>{num}</div><div className="td-kpi-l">{label}</div></div>;
}

function Legend({ wide }) {
  return (
    <div className="td-legend" aria-label="Key">
      <span className="td-key"><span className="td-sw bk used" />Booked</span>
      <span className="td-key"><span className="td-sw wk used" />Walk-in</span>
      <span className="td-key"><span className="td-sw free" />{wide ? "Free place" : "Free"}</span>
      {wide && <span className="td-key"><span className="td-sw bk used past" />Earlier today</span>}
    </div>
  );
}

function Ribbon({ d }) {
  const blocks = d.blocks, n = blocks.length;
  const maxCells = Math.max(1, ...blocks.map((b) => Math.max(b.bookingCapacity, b.booked) + Math.max(b.walkinCapacity, b.walkIn)));
  const gap = maxCells > 14 ? 2 : 3;
  const cellH = Math.max(4, Math.min(24, Math.floor((232 - (maxCells - 1) * gap) / maxCells)));
  const H = Math.max(120, maxCells * cellH + (maxCells - 1) * gap);
  const nowIdx = blocks.findIndex((b) => d.nowMinutes >= b.start && d.nowMinutes < b.start + 30);
  const nowPct = nowIdx >= 0 ? ((nowIdx + (d.nowMinutes - blocks[nowIdx].start) / 30) / n) * 100 : null;
  const hourStep = n > 36 ? 2 : 1; // label only on the hour, thinned out as columns get narrower
  const cols = `repeat(${n}, minmax(0, 1fr))`;
  return (
    <div className="td-ribbon">
      <div className="td-row-staff">
        <span className="td-row-lbl">Staff on</span>
        <div className="td-grid" style={{ gridTemplateColumns: cols }}>
          {blocks.map((b) => <div key={b.start} className="mono td-staff" style={n > 28 ? { fontSize: 11 } : undefined}>{b.staff}</div>)}
        </div>
      </div>
      <div className="td-row-chart">
        <span className="td-row-lbl" aria-hidden="true" />
        <div className="td-chart" style={{ height: H }}>
          <div className="td-grid td-cols" style={{ gridTemplateColumns: cols, gap: 4 }} role="list" aria-label="Half-hour blocks">
            {blocks.map((b) => {
              const past = b.start + 30 <= d.nowMinutes;
              const label = `${fmt(b.start)}: ${b.staff} staff, ${b.booked} of ${b.bookingCapacity} booked, ${b.walkIn} of ${b.walkinCapacity} walk-in places used`;
              return (
                <div key={b.start} className="td-col" role="listitem" aria-label={label} title={label} style={{ gap }}>
                  {cellsFor(b.booked, b.bookingCapacity, b.walkIn, b.walkinCapacity).map((c, i) => <div key={i} className={cellClass(c, past)} style={{ height: cellH }} />)}
                </div>
              );
            })}
          </div>
          {nowPct !== null && <div className="td-now" style={{ left: `${nowPct}%` }} aria-hidden="true"><span>{clock(d.nowMinutes)}</span></div>}
        </div>
      </div>
      <div className="td-row-axis">
        <span className="td-row-lbl" aria-hidden="true" />
        <div className="td-grid" style={{ gridTemplateColumns: cols, gap: 4 }} aria-hidden="true">
          {blocks.map((b) => <div key={b.start} className="td-axis">{b.start % 60 === 0 && Math.floor(b.start / 60) % hourStep === 0 ? fmt(b.start) : ""}</div>)}
        </div>
      </div>
    </div>
  );
}

function HourRows({ d }) {
  const groups = new Map();
  d.blocks.forEach((b) => {
    const h = Math.floor(b.start / 60);
    const g = groups.get(h) || { h, staff: 0, bkCap: 0, bk: 0, wkCap: 0, wk: 0, end: 0 };
    g.staff = Math.max(g.staff, b.staff); g.bkCap += b.bookingCapacity; g.bk += b.booked;
    g.wkCap += b.walkinCapacity; g.wk += b.walkIn; g.end = Math.max(g.end, b.start + 30);
    groups.set(h, g);
  });
  const rows = [...groups.values()];
  return (
    <div className="td-hours" role="list" aria-label="Hour by hour">
      <div className="td-hours-head" aria-hidden="true"><span style={{ width: 44 }}>Hour</span><span style={{ width: 24, textAlign: "center" }}>Staff</span><span style={{ flex: 1 }} /><span style={{ width: 64, textAlign: "right" }}>Free</span></div>
      {rows.map((g) => {
        const past = g.end <= d.nowMinutes;
        const cur = d.nowMinutes >= g.h * 60 && d.nowMinutes < g.end;
        const free = Math.max(0, g.bkCap - g.bk), wkLeft = Math.max(0, g.wkCap - g.wk);
        const txt = past ? "done" : g.bkCap === 0 ? (wkLeft ? `${wkLeft} walk-in` : "Full") : free === 0 ? "Full" : `${free} free`;
        const tone = past ? "past" : (g.bkCap === 0 ? wkLeft : free) === 0 ? "full" : "open";
        return (
          <div key={g.h} role="listitem" className={`td-hrow${cur ? " cur" : ""}`} aria-current={cur ? "time" : undefined}
            aria-label={`${fmt(g.h * 60)}: ${g.staff} staff, ${g.bk} of ${g.bkCap} booked, ${g.wk} of ${g.wkCap} walk-in used, ${txt}`}>
            <span className="mono td-hlbl">{fmt(g.h * 60)}</span>
            <span className="mono td-hstaff">{g.staff}</span>
            <div className="td-hcells" aria-hidden="true">
              {cellsFor(g.bk, g.bkCap, g.wk, g.wkCap).map((c, i) => <div key={i} className={cellClass(c, past)} />)}
            </div>
            <span className={`td-hfree ${tone}`}>{txt}</span>
          </div>
        );
      })}
    </div>
  );
}

const ALL = "__all__";

// Combine several services' "today" payloads into one (sums per half-hour block).
function mergeToday(list) {
  const open = list.filter((r) => r && r.open);
  if (open.length === 0) return list.find((r) => r) || null;
  const byStart = new Map();
  open.forEach((r) => r.blocks.forEach((b) => {
    const g = byStart.get(b.start) || { start: b.start, staff: 0, booked: 0, walkIn: 0, bookingCapacity: 0, walkinCapacity: 0 };
    g.staff += b.staff; g.booked += b.booked; g.walkIn += b.walkIn;
    g.bookingCapacity += b.bookingCapacity; g.walkinCapacity += b.walkinCapacity;
    byStart.set(b.start, g);
  }));
  const sum = (f) => open.reduce((n, r) => n + (f(r) || 0), 0);
  return {
    ...open[0], open: true,
    mode: open.every((r) => r.mode === "queue") ? "queue" : open.find((r) => r.mode !== "queue")?.mode,
    blocks: [...byStart.values()].sort((a, b) => a.start - b.start),
    totals: { freeLeft: sum((r) => r.totals?.freeLeft), bookedTotal: sum((r) => r.totals?.bookedTotal) },
    queueCount: sum((r) => r.queueCount), staffNow: sum((r) => r.staffNow),
  };
}

// services: [{ id, name, locationName? }]. embedded: hide the title row (the host supplies one).
// allOption: add "All services" (the default) to the drop-down, combining every service.
export default function TodayPanel({ services, embedded = false, refreshMs = 30000, allOption = false }) {
  const useAll = allOption && services.length > 1;
  const [serviceId, setServiceId] = useState(useAll ? ALL : services[0]?.id || "");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const wide = useWide(rootRef);
  const idRef = useRef(serviceId);
  const svcRef = useRef(services);
  svcRef.current = services;

  // Keep the selection valid when the list changes (default: first service).
  useEffect(() => {
    if (serviceId === ALL && useAll) return;
    if (!services.some((s) => s.id === serviceId)) setServiceId(useAll ? ALL : services[0]?.id || "");
  }, [services, serviceId, useAll]);

  const load = useCallback(async (id) => {
    if (!id) return;
    try {
      const r = id === ALL
        ? mergeToday(await Promise.all(svcRef.current.map((s) => api.getToday(s.id, localMinutes()).catch(() => null))))
        : await api.getToday(id, localMinutes());
      if (idRef.current === id) { setData(r); setError(""); }
    } catch (err) { if (idRef.current === id) setError(err.message || "Couldn't load today."); }
  }, []);
  useEffect(() => {
    idRef.current = serviceId;
    setData(null); setError("");
    load(serviceId);
    const t = setInterval(() => load(serviceId), refreshMs);
    return () => clearInterval(t);
  }, [serviceId, load, refreshMs]);

  const svc = serviceId === ALL ? { name: "All services" } : services.find((s) => s.id === serviceId);
  const multi = services.length > 1;
  const sub = [data ? fmtDate(data.date) : null, svc?.locationName, multi ? null : svc?.name].filter(Boolean).join(" · ");
  const d = data && data.open ? data : null;
  const queueOnly = data?.mode === "queue";
  const walkLeft = d ? d.blocks.filter((b) => b.start + 30 > d.nowMinutes).reduce((n, b) => n + Math.max(0, b.walkinCapacity - b.walkIn), 0) : 0;
  const tips = d ? insights(d.blocks, d.nowMinutes) : [];

  return (
    <section ref={rootRef} className={`today${embedded ? " embedded" : ""}`} aria-label="Today, day by day">
      <div className="td-head">
        {!embedded && <div className="td-title"><h2>Today</h2></div>}
        {multi && (
          <label className="td-select">
            <span className="sr-only">Service</span>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} aria-label="Service">
              {useAll && <option value={ALL}>All services</option>}
              {services.map((s) => <option key={s.id} value={s.id}>{s.locationName ? `${s.locationName} · ${s.name}` : s.name}</option>)}
            </select>
          </label>
        )}
        <div className="td-sub">{sub}</div>
        {d && <div className="td-now-badge"><span>Now</span> <strong className="mono">{clock(d.nowMinutes)}</strong></div>}
      </div>

      {services.length === 0 && <div className="td-msg">No services yet. Add one to see today here.</div>}
      {error && <div className="td-msg td-err" role="alert">{error} <button type="button" className="btn-outline td-retry" onClick={() => load(serviceId)}>Try again</button></div>}
      {services.length > 0 && !data && !error && <div className="td-msg" role="status">Loading today…</div>}
      {data && !data.open && <div className="td-msg" role="status">{data.reason === "closed" ? NO_HOURS : NO_LICENCE}</div>}

      {d && (
        <>
          <div className="td-kpis">
            <Kpi num={queueOnly ? walkLeft : d.totals.freeLeft} label={queueOnly ? "Walk-in places left" : wide ? "Slots still free today" : "Slots free"} tone="blue" />
            {!queueOnly && <Kpi num={d.totals.bookedTotal} label={wide ? "Booked today" : "Booked"} />}
            <Kpi num={d.queueCount} label={wide ? "In the queue now" : "In queue"} tone="amber" />
            {wide && <Kpi num={d.staffNow} label="Staff working now" />}
          </div>
          <div className="td-card">
            {wide && <h3 className="td-h3">The day, half hour by half hour</h3>}
            <Legend wide={wide} />
            {wide ? <Ribbon d={d} /> : <HourRows d={d} />}
          </div>
          {wide && tips.length > 0 && (
            <div className="td-tips">
              {tips.map((t) => <div key={t.key} className="td-tip"><strong>{t.title}:</strong> {t.text}</div>)}
            </div>
          )}
        </>
      )}
    </section>
  );
}
