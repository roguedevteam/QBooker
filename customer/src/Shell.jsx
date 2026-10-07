import { useLayoutEffect, useRef } from "react";

export function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect x="6" y="10" width="30" height="30" fill="#C8690D" />
      <circle cx="42" cy="22" r="7" fill="#1D5C8A" />
    </svg>
  );
}

export const POWERED_BY = "Powered by QBooker · No sign-up, no app to install";

function clockText(at) {
  try { return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

// A chat bubble. "bot" = the clinic (left, white); "user" = the patient's reply (right, blue, ticked).
export function Bubble({ from = "bot", at, children }) {
  const born = useRef(Date.now());
  return (
    <div className={`msg msg-${from}`}>
      <div className="bubble">
        <div className="bubble-text">{children}</div>
        <div className="bubble-time">{clockText(at || born.current)}{from === "user" && <span className="tick" aria-label="sent"> ✓✓</span>}</div>
      </div>
    </div>
  );
}

// Page frame shared by every screen: navy header, scrolling conversation, footer strip.
export default function Shell({ title, subtitle, footer, scrollKey, top = false, listProps, children }) {
  const scrollRef = useRef(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && !top) el.scrollTop = el.scrollHeight;
  }, [scrollKey, top]);
  return (
    <div className="app">
      <header className="head">
        <Mark />
        <div className="head-text">
          <h1 className="head-title">{title}</h1>
          <p className="head-sub">{subtitle}</p>
        </div>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        <div className={`chat-list${top ? " chat-list-top" : ""}`} {...listProps}>{children}</div>
      </div>
      <footer className="foot">{footer}</footer>
    </div>
  );
}

export function Choices({ options, onPick, busy }) {
  if (!options || options.length === 0) return null;
  return (
    <div className="choices" role="group" aria-label="Your options">
      {options.map((o, i) => (
        <button
          key={i}
          type="button"
          className={`choice ${o.variant === "primary" ? "choice-primary" : "choice-secondary"}`}
          disabled={o.disabled || busy}
          onClick={() => onPick(o)}
        >
          <span className="choice-label">{o.label}</span>
          {o.sub && <span className="choice-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}
