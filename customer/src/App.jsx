import { useState, useEffect, useRef } from "react";
import { api } from "./lib/api.js";
import { todayIso, refreshClock } from "./lib/clock.js";
import { getSavedToken, saveToken, clearSavedToken, setUrlToken, urlParam, getDeviceId } from "./lib/storage.js";
import Returning from "./Returning.jsx";
import Shell, { Bubble, Choices, POWERED_BY } from "./Shell.jsx";

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatTime(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

export default function App() {
  const [tenantId, setTenantId] = useState(() => new URLSearchParams(window.location.search).get("t") || "");
  const [manualEntry, setManualEntry] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { refreshClock().then(() => setReady(true)); }, []);

  if (!ready) return <div className="screen-msg muted" role="status">Loading…</div>;

  if (!tenantId) {
    return (
      <form className="narrow card stack entry" onSubmit={(e) => { e.preventDefault(); if (manualEntry.trim()) setTenantId(manualEntry.trim()); }}>
        <h1 className="entry-title">QBooker</h1>
        <p className="muted entry-copy">
          This page needs a business link to know who you're booking with — normally you'd arrive here
          via a link shared by the business. For testing, paste the business ID shown in their Admin portal.
        </p>
        <label className="sr-only" htmlFor="biz-id">Business ID</label>
        <input id="biz-id" className="input" placeholder="Business ID" autoComplete="off" value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} />
        <button className="btn btn-accent" type="submit" disabled={!manualEntry.trim()}>Continue</button>
      </form>
    );
  }

  return <Patient tenantId={tenantId} />;
}

function Patient({ tenantId }) {
  const [businessName, setBusinessName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState([]);
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [options, setOptions] = useState([]);
  const [serviceName, setServiceName] = useState(""); // header subtitle
  const [currentLoc, setCurrentLoc] = useState(null);
  const [liveToken, setLiveToken] = useState(() => urlParam("k") || getSavedToken(tenantId) || ""); // set => live ticket screen
  const [placeNotFound, setPlaceNotFound] = useState(false); // ?l= location link that doesn't match an active location
  const [startLoc, setStartLoc] = useState(undefined); // undefined = config not loaded yet; null = ask which location
  const [codePrompt, setCodePrompt] = useState(null); // { svcId } — on-site code needed to join
  const [codeInput, setCodeInput] = useState("");
  const [joining, setJoining] = useState(false);
  const onsiteCodeRef = useRef(urlParam("c").trim().toUpperCase()); // from the QR link, or typed in
  // Location-scoped link (?l= with no ?s=): only that location's services are offered.
  const scopedLocRef = useRef(urlParam("s") ? "" : urlParam("l").trim());
  const runRef = useRef(0); // bumped on every (re)start so stale async work doesn't post into a new conversation
  const manyServicesRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [info, l, sv] = await Promise.all([api.getInfo(tenantId), api.getLocations(tenantId), api.getServices(tenantId)]);
        if (cancelled) return;
        setBusinessName(info.businessName);
        setWebsiteUrl(info.websiteUrl || "");
        setLocations(l.locations);
        setServices(sv.services);
        // Which location did the patient arrive at? The QR link carries the location code (?c=)
        // and sometimes a service (?s=); a single-location business needs neither.
        let entry = null;
        const code = urlParam("c").trim();
        if (scopedLocRef.current) {
          if (l.locations.some((x) => x.id === scopedLocRef.current)) entry = scopedLocRef.current;
          else { setPlaceNotFound(true); return; }
        } else if (code) {
          try { const ci = await api.getCodeInfo(code); if (ci.tenantId === tenantId) entry = ci.locationId; } catch { /* unknown code: ignore */ }
        }
        if (!entry) { const sid = urlParam("s"); const svc = sv.services.find((x) => x.id === sid); if (svc) entry = svc.location_id; }
        if (!entry && l.locations.length === 1) entry = l.locations[0].id;
        if (!cancelled) setStartLoc(entry);
      } catch { if (!cancelled) setNotFound(true); }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  // Runs once the config is in state (the flow reads it).
  useEffect(() => {
    if (startLoc === undefined || placeNotFound) return;
    beginChat(startLoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLoc]);

  function bot(text, opts) { setMessages((m) => [...m, { from: "bot", text, at: Date.now() }]); setOptions(opts || []); }
  function user(text) { setMessages((m) => [...m, { from: "user", text, at: Date.now() }]); setOptions([]); }
  const startAgain = [{ label: "Start again", action: "restart" }];
  // "Visit our website" (the business's site, where opening hours live), offered whenever a patient can't be seen today.
  const websiteOpts = (loc) => (websiteUrl || loc?.website_url) ? [{ label: "Visit our website", sub: "See opening hours", variant: "secondary", action: "website", payload: websiteUrl || loc.website_url }] : [];

  function beginChat(locId) {
    runRef.current += 1;
    const where = locations.find((l) => l.id === locId)?.name;
    setMessages([{ from: "bot", text: `Welcome to ${businessName}${where && locations.length > 1 ? ` — ${where}` : ""}.`, at: Date.now() }]);
    setOptions([]);
    setCodePrompt(null);
    setServiceName("");
    setCurrentLoc(null);
    if (locId) showServices(locId);
    else if (locations.length > 1) showLocations();
    else showServices(locations[0]?.id);
  }

  async function showLocations() {
    const run = runRef.current;
    const checks = await Promise.all(locations.map(async (l) => {
      const locServices = services.filter((s) => s.location_id === l.id);
      if (locServices.length === 0) return { location: l, open: false };
      const results = await Promise.all(locServices.map((s) =>
        api.getAvailability(tenantId, s.id, todayIso(), nowMinutes()).catch(() => ({ open: false }))
      ));
      return { location: l, open: results.some((r) => r.open) };
    }));
    if (run !== runRef.current) return;
    // Every location shows up, but only the ones with something open right now can be tapped.
    const anyOpen = checks.some((c) => c.open);
    bot(anyOpen ? "Which location are you at?" : "We're not open right now — nothing is available today. Please check back during opening hours.", [...checks.map(({ location, open }) => ({
      label: location.name,
      sub: open ? "Open now" : "Not available",
      variant: "secondary",
      action: open ? "loc" : null,
      payload: location.id,
      disabled: !open,
    })), ...websiteOpts(null)]);
  }

  // Only services that are open right now are offered. Exactly one open service: skip the picker.
  async function showServices(locId) {
    const run = runRef.current;
    setCurrentLoc(locId || null);
    const list = services.filter((s) => s.location_id === locId);
    const location = locations.find((l) => l.id === locId);
    // Nothing to offer: welcome them to this location and point to the business website.
    const siteLink = websiteOpts(location);
    const welcomeHere = () => setMessages((m) => m.map((x, i) => (i === 0 ? { ...x, text: `Welcome to ${location?.name || businessName}.` } : x))); // replaces the opening welcome so it names the location
    if (list.length === 0) { welcomeHere(); bot("Nothing is available here today.", siteLink); return; }
    const checks = await Promise.all(list.map(async (s) => {
      try {
        const r = await api.getAvailability(tenantId, s.id, todayIso(), nowMinutes());
        return { service: s, open: r.open, reason: r.reason, r };
      } catch {
        return { service: s, open: false, reason: "error" };
      }
    }));
    if (run !== runRef.current) return;
    const live = checks.filter((c) => c.open);
    manyServicesRef.current = live.length > 1;
    if (live.length === 0) {
      const reasons = new Set(checks.map((c) => c.reason));
      let text = "We're not open right now — nothing here is available today. Please check back during opening hours.";
      if (reasons.size === 1) {
        const reason = [...reasons][0];
        if (reason === "outside_license_window") text = "This service's license doesn't cover today's date — please contact the business directly.";
        else if (reason === "paused") text = "We're temporarily paused right now — please try again shortly.";
      }
      welcomeHere();
      bot(text, siteLink);
      return;
    }
    if (live.length === 1) { await chooseService(live[0].service, live[0].r, false); return; }
    bot("Which service do you need today?", live.map((c) => ({ label: c.service.name, variant: "secondary", action: "svc", payload: c.service.id })));
  }

  async function chooseService(svc, avail, echo) {
    const run = runRef.current;
    setServiceName(svc.name);
    if (echo) user(svc.name);
    const another = [...(manyServicesRef.current ? [{ label: "Choose another service", variant: "secondary", action: "restart" }] : []), ...websiteOpts(locations.find((l) => l.id === (currentLoc || svc.location_id)))];
    let r = avail;
    if (!r) {
      try { r = await api.getAvailability(tenantId, svc.id, todayIso(), nowMinutes()); }
      catch (err) { if (run === runRef.current) bot(`Sorry — ${err.message}`, startAgain.map((o) => ({ ...o, variant: "secondary" }))); return; }
      if (run !== runRef.current) return;
    }
    if (!r.open) {
      bot(r.reason === "outside_license_window" ? "We're not taking bookings today." : `${svc.name} isn't available right now.`, another);
      return;
    }
    const canQueue = !!r.walkIn?.available;
    const slots = r.bookableSlots || [];
    const joinOpt = { label: "Join the queue now", variant: "primary", action: "join", payload: svc.id };
    if (canQueue && slots.length > 0) {
      bot("How would you like to be seen?", [joinOpt, { label: "Book an appointment", sub: "Pick a time today or later", variant: "secondary", action: "bookmenu", payload: { serviceId: svc.id, slots } }]);
    } else if (canQueue) {
      bot("Ready to join the queue?", [joinOpt]);
    } else if (slots.length > 0) {
      showSlots(svc.id, slots);
    } else {
      bot(`${svc.name} is fully booked for the rest of today.`, another);
    }
  }

  // Planners see a 2-hour window starting 2 hours from now; other times are one tap away.
  function showSlots(serviceId, slots) {
    const winStart = nowMinutes() + 120;
    let shown = slots.filter((t) => t >= winStart && t < winStart + 120);
    if (shown.length === 0) shown = slots.filter((t) => t >= winStart).slice(0, 3);
    if (shown.length === 0) shown = slots.slice(0, 3);
    shown = shown.slice(0, 8);
    const opts = shown.map((t) => ({ label: `${formatTime(t)} today`, variant: "secondary", action: "book", payload: { serviceId, slotTime: t } }));
    const rest = slots.filter((t) => !shown.includes(t));
    if (rest.length > 0) opts.push({ label: "Choose another time", variant: "secondary", action: "times", payload: { serviceId, slots: rest } });
    bot("Pick a time that suits you:", opts);
  }

  async function handle(action, payload) {
    if (action === "loc") {
      user(locations.find((l) => l.id === payload)?.name);
      await showServices(payload);
    } else if (action === "svc") {
      await chooseService(services.find((s) => s.id === payload), null, true);
    } else if (action === "bookmenu") {
      user("Book an appointment");
      showSlots(payload.serviceId, payload.slots);
    } else if (action === "times") {
      user("Choose another time");
      const { serviceId, slots } = payload;
      const groupsBy = (sz) => { const m = new Map(); slots.forEach((t) => { const k = Math.floor(t / sz); m.set(k, [...(m.get(k) || []), t]); }); return m; };
      let sz = 60;
      let groups = groupsBy(sz);
      if ([...groups.values()].some((g) => g.length > 9)) { sz = 30; groups = groupsBy(sz); }
      const blocks = [...groups.entries()];
      const slotOpts = (list) => list.map((t) => ({ label: `${formatTime(t)} today`, variant: "secondary", action: "book", payload: { serviceId, slotTime: t } }));
      if (blocks.length === 1 || slots.length <= 9) bot("Pick a time:", slotOpts(slots.slice(0, 9)));
      else bot("Which part of the day suits you?", blocks.slice(0, 9).map(([k, g]) => ({ label: `${formatTime(k * sz)} – ${formatTime(k * sz + sz - 1)}`, sub: `${g.length} free`, variant: "secondary", action: "timeblock", payload: { serviceId, slots: g } })));
    } else if (action === "timeblock") {
      user("Choose a time block");
      bot("Pick a time:", payload.slots.slice(0, 9).map((t) => ({ label: `${formatTime(t)} today`, variant: "secondary", action: "book", payload: { serviceId: payload.serviceId, slotTime: t } })));
    } else if (action === "join") {
      const svc = services.find((s) => s.id === payload);
      const loc = locations.find((l) => l.id === svc.location_id);
      user("Join the queue now");
      // "Only joinable from the clinic": the QR link carries the location code; without it, ask for it.
      if (loc?.onsite_only && !onsiteCodeRef.current) { askForCode(svc.id); return; }
      await doJoin(svc);
    } else if (action === "book") {
      const svc = services.find((s) => s.id === payload.serviceId);
      user(`${formatTime(payload.slotTime)} today`);
      try {
        const r = await api.createTicket(tenantId, svc.id, { type: "booked", date: todayIso(), slotTime: payload.slotTime, deviceId: getDeviceId() });
        openTicket(r.publicToken);
      } catch (err) { bot(`Sorry — ${err.message}`, startAgain.map((o) => ({ ...o, variant: "secondary" }))); }
    } else if (action === "website") {
      window.open(payload, "_blank", "noopener");
    } else if (action === "restart") {
      beginChat(startLoc ?? null);
    }
  }

  // Hand over to the live ticket screen; the token is the only thing needed to find the ticket again.
  function openTicket(token) {
    if (!token) { bot("Sorry — something went wrong saving your ticket. Please ask at reception.", startAgain.map((o) => ({ ...o, variant: "secondary" }))); return; }
    saveToken(tenantId, token); // so reopening this page on this phone finds the ticket
    setUrlToken(token);
    setLiveToken(token);
  }

  function askForCode(svcId, message) {
    setCodeInput("");
    setCodePrompt({ svcId });
    bot(message || "This clinic asks you to join from the clinic. Scan the QR code at reception again, or type the location code shown there.", []);
  }

  async function doJoin(svc, code = onsiteCodeRef.current) {
    setJoining(true);
    try {
      const r = await api.createTicket(tenantId, svc.id, { type: "walk_in", date: todayIso(), hourBlock: null, deviceId: getDeviceId(), onsiteCode: code || undefined });
      openTicket(r.publicToken);
    } catch (err) {
      if (err.reason === "onsite_code_required" || err.reason === "onsite_code_invalid") {
        onsiteCodeRef.current = "";
        askForCode(svc.id, err.message);
      } else {
        bot(`Sorry — ${err.message}`, startAgain.map((o) => ({ ...o, variant: "secondary" })));
      }
    } finally { setJoining(false); }
  }

  if (notFound) {
    return <div className="narrow card screen-error" role="alert">We couldn't find that business. Check the link and try again.</div>;
  }

  if (placeNotFound) {
    return <div className="narrow card screen-error" role="alert">We can't find that place. Scan the QR code again.</div>;
  }

  if (liveToken) {
    return (
      <Returning
        token={liveToken}
        onSeen={() => { saveToken(tenantId, liveToken); setUrlToken(liveToken); }}
        onEnded={() => { clearSavedToken(tenantId); }}
        onRestart={() => { clearSavedToken(tenantId); setUrlToken(""); setLiveToken(""); beginChat(startLoc ?? null); }}
      />
    );
  }

  const locName = locations.length > 1 ? locations.find((l) => l.id === currentLoc)?.name : "";
  return (
    <Shell
      title={locName || businessName || "QBooker"}
      subtitle={serviceName || "Join or book online"}
      footer={POWERED_BY}
      scrollKey={`${messages.length}-${options.length}-${!!codePrompt}`}
      listProps={{ role: "log", "aria-live": "polite", "aria-label": "Conversation" }}
    >
      {messages.length === 0 && <p className="muted loading" role="status">Loading…</p>}
      {messages.map((m, i) => <Bubble key={i} from={m.from} at={m.at}>{m.text}</Bubble>)}
      {codePrompt ? (
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault();
            const code = codeInput.trim().toUpperCase();
            if (!code) return;
            onsiteCodeRef.current = code;
            const svc = services.find((x) => x.id === codePrompt.svcId);
            setCodePrompt(null);
            if (svc) doJoin(svc, code);
          }}
        >
          <label htmlFor="onsite-code" className="code-label">Location code (shown at reception)</label>
          <input id="onsite-code" className="input mono" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="QB-XXXXXX" autoComplete="off" autoCapitalize="characters" spellCheck="false" />
          <button className="choice choice-primary" type="submit" disabled={!codeInput.trim() || joining}><span className="choice-label">Join the queue now</span></button>
          <button className="choice choice-secondary" type="button" onClick={() => beginChat(startLoc ?? null)}><span className="choice-label">Back</span></button>
        </form>
      ) : (
        <Choices options={options} busy={joining} onPick={(o) => { if (!o.disabled) handle(o.action, o.payload); }} />
      )}
    </Shell>
  );
}
