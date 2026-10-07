import { useState } from "react";

// The WhatsApp business number isn't connected yet. Set VITE_WHATSAPP_NUMBER (digits only, with
// country code, e.g. 447700900123) once it exists; until then "Open WhatsApp" is a clearly
// marked placeholder that explains itself instead of linking anywhere.
const WA_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER || "").replace(/\D/g, "");

function waHref(code) {
  return WA_NUMBER ? `https://wa.me/${WA_NUMBER}${code ? `?text=${encodeURIComponent(code)}` : ""}` : null;
}

function GateShell({ children }) {
  return (
    <div className="gate">
      <header className="gate-head">
        <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="10" width="30" height="30" fill="#C8690D" /><circle cx="42" cy="22" r="7" fill="#1D5C8A" /></svg>
        <span className="gate-brand">QBooker</span>
      </header>
      <main className="gate-main">{children}</main>
    </div>
  );
}

function WhatsAppButton({ code, className, children, onUnavailable }) {
  const href = waHref(code);
  if (href) {
    return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  return (
    <button type="button" className={className} aria-describedby="wa-unavailable" onClick={onUnavailable}>
      {children}
    </button>
  );
}

// Shown only when the location's channel_mode is "both".
export function ChannelLanding({ businessName, title, code, onContinue }) {
  const [notice, setNotice] = useState(false);
  return (
    <GateShell>
      <div>
        <div className="gate-eyebrow">{businessName}</div>
        <h1 className="gate-title">{title}</h1>
        <p className="gate-lede">Join the queue or book an appointment. Pick whichever is easiest for you. It's the same queue either way.</p>
      </div>
      <section className="gate-card gate-card-primary" aria-labelledby="gc-web">
        <div className="gate-card-head"><h2 id="gc-web">Continue on this page</h2><span className="pill-green">No app needed</span></div>
        <p className="gate-card-text">Works in your browser. We save your place on this phone, so you can come back to this page and see where you are.</p>
        <button type="button" className="gate-btn gate-btn-fill" onClick={onContinue}>Continue on this page</button>
      </section>
      <section className="gate-card" aria-labelledby="gc-wa">
        <h2 id="gc-wa">Use WhatsApp</h2>
        <p className="gate-card-text">Get updates as WhatsApp messages. Good if you want to leave and be pinged.</p>
        <WhatsAppButton code={code} className="gate-btn gate-btn-outline" onUnavailable={() => setNotice(true)}>Open WhatsApp</WhatsAppButton>
        <p id="wa-unavailable" className={`gate-note${notice ? " is-shown" : ""}`} role="status">
          {notice ? "WhatsApp isn't switched on for this clinic yet. Please continue on this page instead." : ""}
        </p>
      </section>
      <p className="gate-fine">We don't store clinical details. Only your first name and a phone number if you choose WhatsApp updates.</p>
    </GateShell>
  );
}

// Shown when channel_mode is "whatsapp": the web chat is not offered at all.
export function WhatsAppOnly({ businessName, title, code, onBack }) {
  const live = !!WA_NUMBER;
  return (
    <GateShell>
      <div>
        <div className="gate-eyebrow">{businessName}</div>
        <h1 className="gate-title">{title}</h1>
        <p className="gate-lede">This clinic uses WhatsApp for its queue and bookings. Open WhatsApp and send the message to get started.</p>
      </div>
      <section className="gate-card gate-card-primary" aria-labelledby="gc-wa2">
        <h2 id="gc-wa2">Use WhatsApp</h2>
                {live ? (
          <WhatsAppButton code={code} className="gate-btn gate-btn-fill">Open WhatsApp</WhatsAppButton>
        ) : (
          <>
            <button type="button" className="gate-btn gate-btn-disabled" aria-disabled="true" aria-describedby="wa-unavailable" onClick={(e) => e.preventDefault()}>Open WhatsApp (not set up yet)</button>
            <p id="wa-unavailable" className="gate-note is-shown" role="status">WhatsApp isn't switched on for this clinic yet. Please ask at reception to join the queue.</p>
          </>
        )}
      </section>
      {onBack && <button type="button" className="gate-btn gate-btn-outline" onClick={onBack}>Choose a different location</button>}
    </GateShell>
  );
}
