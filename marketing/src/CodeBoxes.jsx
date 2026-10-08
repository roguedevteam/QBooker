import { useRef } from "react";

// Six single-digit boxes for a one-time code (same behaviour as the staff app): typing moves on, backspace moves back,
// arrow keys move around, and pasting (or an SMS/email autofill) fills them all. `value` is the code as a string.
export default function CodeBoxes({ value, onChange, onEnter, invalid = false, describedBy, autoFocus = true }) {
  const boxes = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || "");
  const set = (arr) => onChange(arr.join("").slice(0, 6));
  const focusBox = (i) => { const el = boxes.current[Math.max(0, Math.min(5, i))]; if (el) { el.focus(); el.select(); } };
  function fill(start, text) {
    const d = text.replace(/\D/g, "");
    if (!d) return;
    const from = d.length >= 6 ? 0 : start;
    const next = [...digits];
    for (let k = 0; k < d.length && from + k < 6; k++) next[from + k] = d[k];
    set(next);
    focusBox(from + d.length >= 6 ? 5 : from + d.length);
  }
  function onBoxChange(i, raw) {
    const d = raw.replace(/\D/g, "");
    if (!d) { const next = [...digits]; next[i] = ""; set(next); return; }
    if (d.length === 2 && digits[i]) { fill(i, d.slice(-1)); return; } // typed over a filled box
    fill(i, d);
  }
  function onKeyDown(i, e) {
    // A digit key is handled here (not only in onChange): typing the same digit over a filled box changes nothing, so no change
    // event would fire and the cursor would not move on. Phone keyboards and autofill still arrive through onChange.
    if (/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fill(i, e.key); return; }
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) { next[i] = ""; set(next); } else if (i > 0) { next[i - 1] = ""; set(next); focusBox(i - 1); }
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focusBox(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focusBox(i + 1); }
    else if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); }
  }
  return (
    <div className="code-boxes" role="group" aria-label="6-digit code">
      {digits.map((d, i) => (
        <input key={i} ref={(el) => { boxes.current[i] = el; }} className="code-box mono" value={d} type="text" inputMode="numeric" pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"} aria-label={`Digit ${i + 1} of 6`} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          autoFocus={autoFocus && i === 0} onChange={(e) => onBoxChange(i, e.target.value)} onKeyDown={(e) => onKeyDown(i, e)}
          onFocus={(e) => e.target.select()} onPaste={(e) => { e.preventDefault(); fill(i, e.clipboardData.getData("text")); }} />
      ))}
    </div>
  );
}
