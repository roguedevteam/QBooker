import { useState, useEffect, useRef } from "react";
import { api, setToken } from "./lib/api.js";
import { plainError } from "./lib/util.js";

const RESEND_SECONDS = 60;
const emailLooksOk = (e) => /^\S+@\S+\.\S+$/.test(e.trim());

export default function SignIn({ onSignedIn }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [demoOtp, setDemoOtp] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const boxes = useRef([]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode(isResend = false) {
    setError(""); setNotice("");
    if (!emailLooksOk(email)) { setError("That doesn't look like an email address. Check it and try again."); return; }
    setBusy(true);
    try {
      const r = await api.requestStaffOtp(email.trim());
      setDemoOtp(r.demoOtp || null);
      setCooldown(RESEND_SECONDS);
      if (isResend) { setNotice("We've sent you a new code."); setDigits(["", "", "", "", "", ""]); boxes.current[0]?.focus(); }
      else setStep("otp");
    } catch (err) {
      setError(plainError(err, "We couldn't send a code just now. Please try again."));
    } finally { setBusy(false); }
  }

  async function verify() {
    const code = digits.join("");
    if (code.length < 6) { setError("Type all 6 digits of the code."); return; }
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await api.verifyStaffOtp(email.trim(), code);
      setToken(r.token);
      onSignedIn(r.tenant, r.staff);
    } catch (err) {
      const net = plainError(err, "");
      setError(/couldn't reach/.test(net) ? net : "That code didn't work. It may be wrong or out of date. Check it, or ask for a new code.");
      setBusy(false);
    }
  }

  function focusBox(i) { const el = boxes.current[Math.max(0, Math.min(5, i))]; if (el) { el.focus(); el.select(); } }
  function fill(start, text) {
    const d = text.replace(/\D/g, "");
    if (!d) return;
    const from = d.length >= 6 ? 0 : start;
    const next = [...digits];
    for (let k = 0; k < d.length && from + k < 6; k++) next[from + k] = d[k];
    setDigits(next);
    setError("");
    focusBox(from + d.length >= 6 ? 5 : from + d.length);
  }
  function onChange(i, raw) {
    const d = raw.replace(/\D/g, "");
    if (!d) { const next = [...digits]; next[i] = ""; setDigits(next); return; }
    if (d.length === 2 && digits[i]) { fill(i, d.slice(-1)); return; } // typed over a filled box
    fill(i, d);
  }
  function onKeyDown(i, e) {
    // A digit key is handled here too: typing the same digit over a filled box fires no change event, so the cursor would not move on.
    if (/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fill(i, e.key); return; }
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) { next[i] = ""; setDigits(next); } else if (i > 0) { next[i - 1] = ""; setDigits(next); focusBox(i - 1); }
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focusBox(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focusBox(i + 1); }
    else if (e.key === "Enter") { e.preventDefault(); verify(); }
  }

  const clock = `${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, "0")}`;

  if (step === "email") {
    return (
      <main className="narrow auth">
        <h1 className="h-big">Sign in</h1>
        <p className="lead">Enter your work email. We'll send you a 6-digit code. No password to remember.</p>
        <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); sendCode(false); }} noValidate>
          <div>
            <label className="field-label lg" htmlFor="staff-email">Email address</label>
            <input id="staff-email" className={`input input-lg${error ? " input-warn" : ""}`} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck="false"
              placeholder="you@example.com" value={email} aria-invalid={!!error} aria-describedby={error ? "auth-error" : undefined}
              onChange={(e) => { setEmail(e.target.value); setError(""); }} />
            {error && <div id="auth-error" className="field-error lg" role="alert">{error}</div>}
          </div>
          <button type="submit" className="btn-big btn-fill" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
        </form>
        <div className="help-card">Can't sign in? Ask your manager to add you under Staff in the admin.</div>
      </main>
    );
  }

  return (
    <main className="narrow auth">
      <h1 className="h-big">Check your email</h1>
      <p className="lead">If <strong className="breakable">{email.trim()}</strong> is on your team's staff list, we've sent it a 6-digit code. Type it here. It arrives in under a minute.</p>
      {demoOtp && <div className="help-card">Demo code: <strong className="mono">{demoOtp}</strong></div>}
      <form className="stack-lg" onSubmit={(e) => { e.preventDefault(); verify(); }} noValidate>
        <div>
          <div className="digits" role="group" aria-label="6-digit code">
            {digits.map((d, i) => (
              <input key={i} ref={(el) => { boxes.current[i] = el; }} className={`digit mono${error ? " digit-warn" : ""}`} value={d}
                type="text" inputMode="numeric" pattern="[0-9]*" autoComplete={i === 0 ? "one-time-code" : "off"} aria-label={`Digit ${i + 1} of 6`}
                aria-invalid={!!error} aria-describedby={error ? "auth-error" : undefined} autoFocus={i === 0}
                onChange={(e) => onChange(i, e.target.value)} onKeyDown={(e) => onKeyDown(i, e)} onFocus={(e) => e.target.select()}
                onPaste={(e) => { e.preventDefault(); fill(i, e.clipboardData.getData("text")); }} />
            ))}
          </div>
          {error && <div id="auth-error" className="field-error lg" role="alert">{error}</div>}
          {notice && !error && <div className="field-ok" role="status">{notice}</div>}
        </div>
        <button type="submit" className="btn-big btn-fill" disabled={busy || digits.join("").length < 6}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <div className="auth-links">
        <button type="button" className="link-btn" disabled={cooldown > 0 || busy} onClick={() => sendCode(true)}>{cooldown > 0 ? `Send a new code (in ${clock})` : "Send a new code"}</button>
        <button type="button" className="link-btn" onClick={() => { setStep("email"); setDigits(["", "", "", "", "", ""]); setError(""); setNotice(""); setCooldown(0); }}>Wrong email? Change it</button>
      </div>
    </main>
  );
}
