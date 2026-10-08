import { useState, useEffect } from "react";
import { api, setToken, hasToken, setAuthLostHandler } from "./lib/api.js";
import { todayIso, isSimulatedToday, refreshClock, setDefaultTimezone } from "./lib/clock.js";
import SignIn from "./SignIn.jsx";
import Shift from "./Shift.jsx";

// Logo mark: an orange ticket with a blue dot, plus the wordmark.
function Logo() {
  return (
    <span className="logo">
      <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true">
        <rect x="6" y="10" width="30" height="30" fill="var(--accent)" />
        <circle cx="42" cy="22" r="7" fill="var(--blue)" />
      </svg>
      <span className="logo-word">QBooker staff</span>
    </span>
  );
}

export default function App() {
  const [tenant, setTenant] = useState(null);
  const [staff, setStaff] = useState(null); // { id, firstName, lastName }
  const [locationId, setLocationId] = useState(null);
  const [canChangeLocation, setCanChangeLocation] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    async function restore() {
      await refreshClock();
      if (hasToken()) {
        try {
          const r = await api.me();
          setTenant(r.tenant);
          setStaff(r.staff);
        } catch {
          setToken(null);
        }
      }
      setRestoring(false);
    }
    restore();
  }, []);

  function signOut() { setToken(null); setTenant(null); setStaff(null); setLocationId(null); }

  // Any call or poll answered with 401/403 (session expired, this person was switched off or removed,
  // or the account was disabled) returns the kiosk to the sign-in screen instead of sitting there failing.
  useEffect(() => {
    setAuthLostHandler(() => {
      setToken(null); setTenant(null); setStaff(null); setLocationId(null);
      setError("You've been signed out. Please sign in again.");
    });
    return () => setAuthLostHandler(null);
  }, []);

  if (tenant?.default_timezone) setDefaultTimezone(tenant.default_timezone); // idempotent; the account's default zone for anything without a location of its own
  if (restoring) return <div className="container muted center-text" role="status">Loading…</div>;

  return (
    <div>
      {!(tenant && locationId) && (
        <header className="app-header">
          <Logo />
          {tenant && <span className="sub">{tenant.business_name}</span>}
          {isSimulatedToday() && <span className="badge badge-amber">Simulated date: {todayIso()}</span>}
        </header>
      )}
      {error && <div className="alert" role="alert"><span>{error}</span><button className="btn-outline" onClick={() => setError("")}>Dismiss</button></div>}

      {!tenant && <SignIn onSignedIn={(t, st) => { setError(""); setTenant(t); setStaff(st); }} />}
      {tenant && !locationId && <LocationPicker staff={staff} onPick={(id, multi) => { setLocationId(id); setCanChangeLocation(multi); }} onSignOut={signOut} setError={setError} />}
      {tenant && locationId && <Shift tenant={tenant} staff={staff} locationId={locationId} setError={setError} onSignOut={signOut} onChangeLocation={canChangeLocation ? () => setLocationId(null) : null} />}
    </div>
  );
}

// After signing in, staff choose which location they're working at (one location is picked automatically).
function LocationPicker({ staff, onPick, onSignOut, setError }) {
  const [locations, setLocations] = useState(null);
  useEffect(() => {
    api.getLocations().then((r) => {
      const active = r.locations.filter((l) => !l.archived);
      setLocations(active);
      if (active.length === 1) onPick(active[0].id, false);
    }).catch((e) => { setError(e.message); setLocations([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!locations) return <div className="container muted center-text" role="status">Loading…</div>;
  return (
    <main className="narrow auth">
      <div>
        <div className="hello">Hello {staff?.firstName}</div>
        <h1 className="h-big">Where are you working today?</h1>
      </div>
      {locations.length === 0 && <div className="help-card">No locations have been set up yet. Ask your manager.</div>}
      <div className="opts">
        {locations.map((l) => <button key={l.id} type="button" className="opt opt-lg" onClick={() => onPick(l.id, locations.length > 1)}><span className="opt-main">{l.name}</span></button>)}
      </div>
      <div><button className="btn-outline" onClick={onSignOut}>Sign out</button></div>
    </main>
  );
}
