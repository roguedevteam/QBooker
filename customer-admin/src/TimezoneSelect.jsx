import { useState } from "react";

// Time zones offered first, with plain names. Anything else is typed under "Other..." as an IANA name
// (Area/City, like America/Sao_Paulo) and checked by the server, which is the authority on what is valid.
export const CURATED_ZONES = [
  ["Europe/London", "United Kingdom (London)"],
  ["Europe/Dublin", "Ireland (Dublin)"],
  ["Europe/Paris", "Central Europe (Paris, Berlin, Madrid)"],
  ["Europe/Athens", "Eastern Europe (Athens, Helsinki)"],
  ["America/New_York", "US & Canada Eastern (New York, Toronto)"],
  ["America/Chicago", "US & Canada Central (Chicago)"],
  ["America/Denver", "US Mountain (Denver)"],
  ["America/Los_Angeles", "US & Canada Pacific (Los Angeles, Vancouver)"],
  ["Asia/Dubai", "Gulf (Dubai)"],
  ["Asia/Kolkata", "India (Kolkata)"],
  ["Asia/Singapore", "Singapore"],
  ["Asia/Tokyo", "Japan (Tokyo)"],
  ["Australia/Sydney", "Australia East (Sydney, Melbourne)"],
  ["Australia/Perth", "Australia West (Perth)"],
  ["Pacific/Auckland", "New Zealand (Auckland)"],
  ["UTC", "UTC (no daylight saving)"],
];
const OTHER = "__other__";

// Controlled: `value` is an IANA zone name; onChange(name) fires on every change (the caller decides when to save).
export default function TimezoneSelect({ id, value, onChange, label = "Time zone", help }) {
  const known = CURATED_ZONES.some(([z]) => z === value);
  const [other, setOther] = useState(!known && !!value);
  const selectValue = other || !known ? OTHER : value;
  return (
    <div className="field" style={{ gap: 6 }}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <select
        id={id}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === OTHER) { setOther(true); return; }
          setOther(false); onChange(e.target.value);
        }}
      >
        {CURATED_ZONES.map(([z, name]) => <option key={z} value={z}>{name}</option>)}
        <option value={OTHER}>Other…</option>
      </select>
      {(other || !known) && (
        <input
          className="input"
          id={`${id}-other`}
          aria-label={`${label}: name of the zone`}
          placeholder="Area/City, for example America/Sao_Paulo"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          value={known ? "" : value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
      <span className="muted small">{help || "Choose where the clinic is, not where you are. It sets the clinic's clock: when each day starts and ends, which hours are open, and when a booking time has passed."}</span>
    </div>
  );
}
