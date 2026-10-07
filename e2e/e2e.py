#!/usr/bin/env python3
"""QBooker end-to-end suite (real browser, real API, no mocks).  See e2e/README.md.

    python3 e2e/e2e.py                       # build + serve + run everything (phone and desktop)
    python3 e2e/e2e.py --vp phone --only A,C # subset

Areas:  A marketing/sign-up   B customer-admin   C patient app   D staff kiosk   E cross-app flow   F system-admin console
"""
import argparse, contextlib, functools, hashlib, http.server, json, os, re, shutil, signal, socket, subprocess
import sys, threading, time, traceback, urllib.error, urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = Path(os.environ.get("E2E_OUT", "/tmp/e2e"))
SHOTS = OUT / "shots"
RUN = time.strftime("%d%H%M%S")  # unique per run -> unique business names / emails
PSQL = os.environ.get("E2E_PSQL", "psql -h /tmp/pgtest -p 5433 -U postgres -d qb_test")
DB_URL = os.environ.get("E2E_DATABASE_URL", "postgresql://postgres@localhost:5433/qb_test")

VIEWPORTS = {
    "phone": dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True),
    "desktop": dict(viewport={"width": 1280, "height": 800}),
}
SAVE_SCREENS = False
IGNORED_URL = re.compile(r"fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com")  # known external font/QR fetches (sandbox has no internet)
APPS = ["marketing", "customer-admin", "staff", "customer", "sysadmin"]
APP_SRC = {"sysadmin": "admin"}   # built from admin/ (the platform team's console), served as "sysadmin"


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------------------------------------
# Infrastructure: ports, builds, static servers, private API instance
# ----------------------------------------------------------------------------------------------------------
def free_port(preferred=None):
    for p in ([preferred] if preferred else []) + [0]:
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", p))
            port = s.getsockname()[1]
            s.close()
            return port
        except OSError:
            s.close()
    raise RuntimeError("no free port")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Infra:
    """Builds the four front-ends, serves their dist dirs and starts a private API process (unless URLs are given)."""

    def __init__(self, args):
        self.args = args
        self.servers, self.proc, self.log_path = [], None, OUT / "api.log"
        self.urls = {}

    def start(self):
        a = self.args
        given = dict(api=a.api_url, marketing=a.marketing_url, admin=a.admin_url, staff=a.staff_url, customer=a.customer_url, sysadmin=a.sysadmin_url)
        if all(given.values()):
            self.urls = {k: v.rstrip("/") for k, v in given.items()}
            log("using running instances:", self.urls)
            return
        ports = dict(api=free_port(4210), marketing=free_port(4211), admin=free_port(4212), staff=free_port(4213), customer=free_port(4214), sysadmin=free_port(4215))
        urls = {k: f"http://localhost:{p}" for k, p in ports.items()}
        for k, v in given.items():
            if v:
                urls[k] = v.rstrip("/")
        self.urls = urls
        OUT.mkdir(parents=True, exist_ok=True)
        stamp = OUT / "urls.json"
        same = stamp.exists() and json.loads(stamp.read_text()) == urls and all((OUT / app / "index.html").exists() for app in APPS)
        if not (a.skip_build and same):
            self.build(urls)
            stamp.write_text(json.dumps(urls))
        for app, key in [("marketing", "marketing"), ("customer-admin", "admin"), ("staff", "staff"), ("customer", "customer"), ("sysadmin", "sysadmin")]:
            if given[key]:
                continue
            handler = functools.partial(Quiet, directory=str(OUT / app))
            srv = http.server.ThreadingHTTPServer(("0.0.0.0", ports[key]), handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers.append(srv)
        if not given["api"]:
            self.start_api(urls, ports["api"])

    def build(self, urls):
        envs = {
            "marketing": dict(VITE_API_URL=urls["api"], VITE_ADMIN_APP_URL=urls["admin"]),
            "customer-admin": dict(VITE_API_URL=urls["api"], VITE_STAFF_APP_URL=urls["staff"], VITE_CUSTOMER_APP_URL=urls["customer"],
                                   VITE_MARKETING_URL=urls["marketing"]),
            "staff": dict(VITE_API_URL=urls["api"]),
            "customer": dict(VITE_API_URL=urls["api"]),
            "sysadmin": dict(VITE_API_URL=urls["api"]),
        }
        log("building front-ends ->", OUT)
        procs = []
        for app in APPS:
            src = ROOT / APP_SRC.get(app, app)
            if not (src / "node_modules").exists():
                raise SystemExit(f"{src.name}/node_modules missing - run npm install there first")
            lp = open(OUT / f"build-{app}.log", "w")
            p = subprocess.Popen(["npx", "vite", "build", "--outDir", str(OUT / app), "--emptyOutDir"], cwd=src,
                                 env={**os.environ, **envs[app]}, stdout=lp, stderr=subprocess.STDOUT)
            procs.append((app, p, lp))
        for app, p, lp in procs:
            rc = p.wait()
            lp.close()
            if rc != 0:
                raise SystemExit(f"build of {app} failed, see {OUT}/build-{app}.log")

    def start_api(self, urls, port):
        host = re.sub(r"^.*@", "", DB_URL).split("/")[0].split(":")[0]
        if host not in ("localhost", "127.0.0.1", "::1") and not host.startswith("/"):
            raise SystemExit(f"refusing to start a test API against non-local database host {host!r}")
        origins = ",".join(urls[k] for k in ("marketing", "admin", "staff", "customer", "sysadmin"))
        hash_ = subprocess.run(["node", "-e", "console.log(require('bcryptjs').hashSync('adminpass',4))"], cwd=ROOT / "server",
                               capture_output=True, text=True).stdout.strip()
        env = {**os.environ, "DATABASE_URL": DB_URL, "DATABASE_SSL": "false", "JWT_SECRET": "testsecret", "PORT": str(port),
               "CORS_ORIGIN": origins, "SYSTEM_ADMIN_PASSWORD_HASH": hash_}
        lf = open(self.log_path, "w")
        self.proc = subprocess.Popen(["node", "--import", str(HERE / "dns-stub.mjs"), "src/index.js"], cwd=ROOT / "server", env=env,
                                     stdout=lf, stderr=subprocess.STDOUT)
        for _ in range(60):
            try:
                urllib.request.urlopen(urls["api"] + "/health", timeout=1).read()
                log("private API instance up on", urls["api"], "(log:", self.log_path, ")")
                return
            except Exception:
                time.sleep(0.5)
        raise SystemExit("private API instance did not start, see " + str(self.log_path))

    def stop(self):
        for s in self.servers:
            s.shutdown()
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ----------------------------------------------------------------------------------------------------------
# Plain HTTP helper for fixtures (real API calls, same endpoints the apps use)
# ----------------------------------------------------------------------------------------------------------
class Api:
    def __init__(self, base):
        self.base = base

    def req(self, method, path, body=None, token=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        if token:
            r.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}

    def ok(self, method, path, body=None, token=None):
        st, js = self.req(method, path, body, token)
        if st >= 400:
            raise RuntimeError(f"{method} {path} -> {st} {js}")
        return js

    def clock_today(self):
        return self.ok("GET", "/api/public/clock")["today"]

    def make_tenant(self, name, locations, services, website=None, license_today=True, hours="all", staff=4, booking=2, walkin=2):
        """locations: [name]; services: [(name, mode, locationIndex)].  Every service gets a licence starting today
        (first one uses the free trial licence).  hours: 'all' (whole day) | list of minute starts | None (no hours)."""
        email = f"e2e-{RUN}-{re.sub('[^a-z0-9]', '', name.lower())[:18]}@example.com"
        st = self.ok("POST", "/api/auth/signup", dict(
            businessName=name, firstName="E2E", lastName="Fixture", email=email,
            locations=[{"name": n} for n in locations],
            services=[dict(name=n, mode=m, locationIndex=li, slotMinutes=15) for n, m, li in services]))
        otp = st["demoOtp"]
        v = self.ok("POST", "/api/auth/admin/verify-otp", dict(email=email, code=otp))
        tok, tenant = v["token"], v["tenant"]
        if website:
            self.ok("PATCH", "/api/tenant/me", dict(websiteUrl=website), tok)
        svcs = self.ok("GET", "/api/tenant/services", token=tok)["services"]
        if license_today:
            for i, s in enumerate(svcs):
                lics = self.ok("GET", f"/api/tenant/services/{s['id']}/licenses", token=tok)["licenses"]
                lic = lics[0] if lics else self.ok("POST", f"/api/tenant/services/{s['id']}/licenses", dict(planId="day", paymentMethod="card"), tok)["license"]
                self.ok("PATCH", f"/api/tenant/services/{s['id']}/licenses/{lic['id']}", dict(startDate=self.clock_today()), tok)
        if hours is not None:
            for s in svcs:
                self.set_hours(tok, s, hours, staff, booking, walkin)
        locs = self.ok("GET", "/api/tenant/locations", token=tok)["locations"]
        return dict(email=email, token=tok, id=tenant["id"], name=name, services=svcs, locations=locs)

    def set_hours(self, tok, svc, hours="all", staff=4, booking=2, walkin=2, date=None):
        hrs = list(range(0, 1440, 30)) if hours == "all" else hours
        sid = svc["id"] if isinstance(svc, dict) else svc
        mode = svc.get("mode") if isinstance(svc, dict) else "hybrid"
        body = dict(date=date or self.clock_today(), hours=hrs, staffCount=staff,
                    bookingStaffCount=booking if mode == "hybrid" else (staff if mode == "appointment" else 0),
                    walkInStaffCount=walkin if mode == "hybrid" else (staff if mode == "queue" else 0))
        return self.ok("PUT", f"/api/tenant/services/{sid}/daily-config", body, tok)

    def join_walkin(self, tenant_id, service_id):
        return self.ok("POST", f"/api/public/tenant/{tenant_id}/services/{service_id}/tickets",
                       dict(type="walk_in", date=self.clock_today(), hourBlock=None))


def psql(sql):
    r = subprocess.run(PSQL.split() + ["-At", "-c", sql], capture_output=True, text=True)
    return r.stdout.strip()


# ----------------------------------------------------------------------------------------------------------
# Results
# ----------------------------------------------------------------------------------------------------------
def slug(s):
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:70]


class Abort(Exception):
    """Raised by a critical step to skip the rest of a journey."""


class Results:
    def __init__(self):
        self.rows = []  # dict(vp, area, name, ok, detail, kind)
        self.vp = "-"
        SHOTS.mkdir(parents=True, exist_ok=True)

    def add(self, area, name, ok, detail="", page=None, kind="check"):
        row = dict(vp=self.vp, area=area, name=name, ok=bool(ok), detail=str(detail)[:900], kind=kind)
        self.rows.append(row)
        if not ok:
            shot = ""
            if page is not None:
                try:
                    shot = str(SHOTS / f"{self.vp}-{area}-{slug(name)}.png")
                    page.screenshot(path=shot)
                except Exception:
                    shot = ""
            row["shot"] = shot
            log(f"  FAIL [{self.vp}/{area}] {name}" + (f"  -- {detail}" if detail else ""))
        return bool(ok)

    def skip(self, area, name, why):
        self.rows.append(dict(vp=self.vp, area=area, name=name, ok=None, detail=why, kind="skip"))
        log(f"  SKIP [{self.vp}/{area}] {name} ({why})")

    @contextlib.contextmanager
    def step(self, area, name, page=None, critical=False):
        """Run a block; an exception (timeout, missing element...) is recorded as a failure instead of crashing the run."""
        try:
            yield
            self.add(area, name, True)
        except Abort:
            raise
        except Exception as e:  # noqa
            msg = str(e).strip().splitlines()[0][:300] if str(e).strip() else type(e).__name__
            pg = page() if callable(page) else page
            self.add(area, name, False, f"{type(e).__name__}: {msg}", pg)
            if os.environ.get("E2E_TRACE"):
                traceback.print_exc()
            if critical:
                raise Abort(name)


# ----------------------------------------------------------------------------------------------------------
# Page monitoring + generic per-screen checks
# ----------------------------------------------------------------------------------------------------------
class Monitor:
    def __init__(self, page):
        self.events, self.allowed = [], []
        page.on("console", self._console)
        page.on("pageerror", lambda e: self._add("pageerror", str(e)))
        page.on("requestfailed", self._reqfailed)
        page.on("response", self._response)

    def _add(self, kind, text, url=""):
        if IGNORED_URL.search(text) or IGNORED_URL.search(url):
            return
        okay = any(re.search(p, text) for p in self.allowed)
        self.events.append((kind, text, okay))

    def _console(self, msg):
        if msg.type == "error":
            self._add("console", msg.text, msg.location.get("url", "") if msg.location else "")

    def _reqfailed(self, req):
        err = req.failure or ""
        if "ERR_ABORTED" in err:  # fetches cancelled by navigation / page close
            return
        self._add("requestfailed", f"{req.method} {req.url} {err}", req.url)

    def _response(self, resp):
        if resp.status >= 400:
            self._add("http", f"{resp.status} {resp.request.method} {resp.url}", resp.url)

    @contextlib.contextmanager
    def expect(self, *patterns):
        """Errors matching these regexes are expected inside the block (e.g. a deliberate 401)."""
        self.allowed = list(patterns)
        try:
            yield
        finally:
            time.sleep(0.3)
            self.allowed = []

    def take(self):
        ev, self.events = self.events, []
        return [e for e in ev if not e[2]]


JS_SCAN = r"""
(phone) => {
  const vis = (el) => { try { return el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}); } catch (e) { return true; } };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    if (c) s += '.' + c;
    const t = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return t ? `${s} "${t}"` : s;
  };
  const out = {overflow: null, small: [], a11y: []};
  const vw = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > vw + 1) {
    const off = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && vis(el)) {
        let p = el.parentElement, clipped = false;
        while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { const pr = p.getBoundingClientRect(); if (pr.right <= vw + 1) { clipped = true; break; } } p = p.parentElement; }
        if (!clipped) off.push(`${desc(el)} right=${Math.round(r.right)}`);
      }
      if (off.length >= 6) break;
    }
    out.overflow = `scrollWidth ${sw} > viewport ${vw}; ` + off.join(' | ');
  }
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=radio], [role=checkbox], [role=menuitem]';
  if (phone) {
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      if (!vis(el)) continue;
      let target = el;
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { const l = el.closest('label'); if (l) target = l; }
      const r = target.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;               // visually hidden (sr-only / custom control)
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;   // inline text link (WCAG target-size exception)
      if (r.height < 43.5) { const d = desc(el); if (!seen.has(d)) { seen.add(d); out.small.push(`${d} ${Math.round(r.width)}x${Math.round(r.height)}`); } }
    }
  }
  // accessibility basics
  const h1 = [...document.querySelectorAll('h1')].filter(vis);
  if (h1.length !== 1) out.a11y.push(`${h1.length} visible h1 (want exactly 1)`);
  for (const img of document.images) if (!img.hasAttribute('alt')) out.a11y.push('img without alt: ' + (img.getAttribute('src') || '').slice(0, 40));
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')) {
    if (!vis(el) && !(el.type === 'checkbox' || el.type === 'radio')) continue;
    const r = el.getBoundingClientRect();
    if ((r.width <= 1 || r.height <= 1) && !(el.labels && el.labels.length)) { if (!el.getAttribute('aria-label')) out.a11y.push('hidden control without label: ' + desc(el)); continue; }
    const lb = el.getAttribute('aria-labelledby');
    const named = el.getAttribute('aria-label') || (lb && document.getElementById(lb.split(' ')[0])) || (el.labels && el.labels.length) || el.getAttribute('title');
    if (!named) out.a11y.push('input without label: ' + desc(el));
  }
  for (const el of document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=switch], [role=radio]')) {
    if (!vis(el)) continue;
    const lb = el.getAttribute('aria-labelledby');
    const name = (el.getAttribute('aria-label') || (lb && (document.getElementById(lb.split(' ')[0]) || {}).textContent) || el.textContent || el.getAttribute('title') || '').trim();
    if (!name) out.a11y.push('control without accessible name: ' + desc(el));
  }
  if (!document.documentElement.lang) out.a11y.push('html has no lang attribute');
  if (!document.title.trim()) out.a11y.push('empty document title');
  return out;
}
"""

JS_FOCUS = r"""
() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const pick = (e) => { const c = getComputedStyle(e); return {ol: c.outlineStyle + ' ' + c.outlineWidth, sh: c.boxShadow, bc: c.borderColor, bg: c.backgroundColor, col: c.color, td: c.textDecorationLine}; };
  const on = pick(el);
  const name = (el.getAttribute('aria-label') || el.innerText || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30);
  const hasOutline = on.ol.split(' ')[0] !== 'none' && parseFloat(on.ol.split(' ')[1]) > 0;
  el.blur();
  const off = pick(el);
  el.focus({focusVisible: true});
  const changed = ['sh', 'bc', 'bg', 'col', 'td'].some((k) => on[k] !== off[k]);
  return {name: `${el.tagName.toLowerCase()} "${name}"`, visible: hasOutline || changed};
}
"""


class Actor:
    """One browser context + page with monitoring (a patient's phone, the admin's laptop, a staff tablet...)."""

    def __init__(self, env, kind=None, **ctx_kw):
        kw = dict(VIEWPORTS[kind or env.vp])
        kw.update(ctx_kw)
        self.env = env
        self.ctx = env.browser.new_context(locale="en-GB", timezone_id="Europe/London", permissions=["clipboard-read", "clipboard-write"], **kw)
        self.ctx.set_default_timeout(env.timeout)
        self.page = self.ctx.new_page()
        self.page.on("dialog", lambda d: d.accept())
        self.mon = Monitor(self.page)
        self.phone = (kind or env.vp) == "phone"
        self.kind = kind or env.vp

    def goto(self, url):
        self.page.goto(url, wait_until="load")

    def scan(self, area, label, focus=False, touch=True, allow=()):
        """Generic checks that apply to every screen."""
        T, p = self.env.T, self.page
        time.sleep(0.25)
        if SAVE_SCREENS:
            try:
                (OUT / "screens").mkdir(exist_ok=True)
                p.screenshot(path=str(OUT / "screens" / f"{self.env.vp}-{area}-{slug(label)}.png"))
            except Exception:
                pass
        ev = [e for e in self.mon.take() if not any(re.search(pt, e[1]) for pt in allow)]
        T.add(area, f"{label}: no console errors / page errors / failed requests", not ev, "; ".join(f"{k}: {t[:160]}" for k, t, _ in ev[:4]), p)
        try:
            r = p.evaluate(JS_SCAN, self.phone and touch)
        except Exception as e:  # page navigated mid-scan
            T.add(area, f"{label}: scan", False, str(e)[:200], p)
            return
        T.add(area, f"{label}: no horizontal overflow", r["overflow"] is None, r["overflow"] or "", p)
        if self.phone and touch:
            T.add(area, f"{label}: touch targets >= 44px high", not r["small"], "; ".join(r["small"][:8]) + (f" (+{len(r['small']) - 8} more)" if len(r["small"]) > 8 else ""), p)
        T.add(area, f"{label}: basic a11y (h1, alt, labels, names)", not r["a11y"], "; ".join(r["a11y"][:6]), p)
        if focus:
            self.check_focus(area, label)

    def check_focus(self, area, label, tabs=6):
        T, p = self.env.T, self.page
        bad, seen = [], []
        try:
            p.evaluate("document.activeElement && document.activeElement.blur()")
            for _ in range(tabs):
                p.keyboard.press("Tab")
                f = p.evaluate(JS_FOCUS)
                if f and f["name"] not in seen:
                    seen.append(f["name"])
                    if not f["visible"]:
                        bad.append(f["name"])
        except Exception as e:
            bad.append("error " + str(e)[:80])
        T.add(area, f"{label}: keyboard focus is visible", bool(seen) and not bad, ("no focusable element reached" if not seen else "") + "; ".join(bad), p)

    def close(self):
        try:
            self.ctx.close()
        except Exception:
            pass


class Env:
    """Everything a journey needs for one viewport."""

    def __init__(self, vp, browser, infra, T, api, timeout):
        self.vp, self.browser, self.infra, self.T, self.api, self.timeout = vp, browser, infra, T, api, timeout
        self.urls = infra.urls
        self.S = {}  # shared state between journeys of this viewport
        self.actors = []

    def actor(self, kind=None, **kw):
        a = Actor(self, kind, **kw)
        self.actors.append(a)
        return a

    def close(self):
        for a in self.actors:
            ev = a.mon.take()
            self.T.add("X", f"final sweep: no stray console/page errors or failed requests ({a.kind})", not ev, "; ".join(f"{k}: {t[:140]}" for k, t, _ in ev[:3]))
            a.close()


# small locator helpers --------------------------------------------------------------------------------------
def V(page, text, exact=False):
    """first visible element containing text"""
    return page.get_by_text(text, exact=exact).filter(visible=True).first


def wait_text(page, text, exact=False, timeout=None):
    V(page, text, exact).wait_for(state="visible", **({"timeout": timeout} if timeout else {}))


def has_text(page, text, exact=False):
    return page.get_by_text(text, exact=exact).filter(visible=True).count() > 0


def btn(page, name, exact=False):
    return page.get_by_role("button", name=name, exact=exact).filter(visible=True).first


def dump_text(page, limit=300):
    try:
        return page.inner_text("body").replace("\n", " | ")[:limit]
    except Exception:
        return ""


# ==========================================================================================================
# A. Marketing page + sign-up -> signed in to the customer-admin app
# ==========================================================================================================
def journey_A(env):
    T, S, A = env.T, env.S, "A"
    S["biz"] = f"e2e-{RUN}-{env.vp}-Clinic"
    S["email"] = f"e2e-{RUN}-{env.vp}@example.com"
    S["loc1"], S["loc2"] = "e2e Riverside", "e2e Harbour"
    a = env.actor()
    p = a.page
    S["admin"] = a
    with T.step(A, "marketing landing page loads with the main call to action", p, critical=True):
        a.goto(env.urls["marketing"])
        wait_text(p, "A digital queue for your clinic")
        btn(p, "Start free trial").wait_for(state="visible")
    a.scan(A, "marketing landing", focus=True)
    with T.step(A, "landing images have loaded (hero + screenshots)", p):
        p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        p.wait_for_timeout(800)
        broken = p.evaluate("[...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src)")
        assert not broken, f"broken images: {broken}"
    with T.step(A, "'Start free trial' opens the sign-up form", p, critical=True):
        p.evaluate("window.scrollTo(0, 0)")
        btn(p, "Start free trial").click()
        wait_text(p, "Set up your account")
    a.scan(A, "sign-up step 1", focus=True)
    with T.step(A, "step 1 validation: empty form shows errors and stays on step 1", p):
        btn(p, "Continue").click()
        wait_text(p, "Enter your business name.")
        assert has_text(p, "Enter your email address.")
    with T.step(A, "step 1 -> 2 with valid details", p, critical=True):
        p.get_by_label("Business name").fill(S["biz"])
        p.get_by_label("First name").fill("Ellie")
        p.get_by_label("Last name").fill("Tester")
        p.get_by_label("Email address").fill(S["email"])
        btn(p, "Continue").click()
        wait_text(p, "Add your locations")
    a.scan(A, "sign-up step 2 (locations)")
    with T.step(A, "step 2: duplicate location names are rejected", p):
        btn(p, "+ Add another location").click()
        p.get_by_label("Location 1 name").fill(S["loc1"])
        p.get_by_label("Location 2 name").fill(S["loc1"])
        wait_text(p, "Each location needs its own name")
        p.get_by_role("button", name="Remove location 2").click()
        assert not has_text(p, "Each location needs its own name")
    with T.step(A, "step 2 -> 3", p, critical=True):
        btn(p, "Continue").click()
        wait_text(p, "Add your services")
    a.scan(A, "sign-up step 3 (services)")
    with T.step(A, "step 3: create the account (queue service)", p, critical=True):
        p.get_by_label("Service name").fill("Blood Test")
        btn(p, "Create account").click()
        wait_text(p, "You're set up")
    with T.step(A, "success page shows the business and a 6-digit demo code", p):
        assert has_text(p, S["biz"])
        S["signup_otp"] = p.locator(".su-code-value").inner_text().strip()
        assert re.fullmatch(r"\d{6}", S["signup_otp"]), S["signup_otp"]
    a.scan(A, "sign-up success")
    with T.step(A, "'Go to admin sign-in' leads to the customer-admin app", p, critical=True):
        p.get_by_role("link", name=re.compile("Go to admin sign-in")).click()
        p.wait_for_url(env.urls["admin"] + "/**")
        wait_text(p, "Admin sign-in")
    a.scan(A, "admin sign-in (email)")
    with T.step(A, "admin sign-in: request code shows the demo code", p, critical=True):
        p.get_by_label("Email address").fill(S["email"])
        btn(p, "Send login code").click()
        wait_text(p, "demo:")
    a.scan(A, "admin sign-in (code)")
    with T.step(A, "admin sign-in: a wrong code is rejected with a clear message", p):
        p.get_by_label("6-digit code").fill("000000")
        with a.mon.expect("401", "Failed to load resource"):
            btn(p, "Verify & sign in").click()
            wait_text(p, "Incorrect or expired code")
    with T.step(A, "admin sign-in: the code from the sign-up page signs the owner in", p, critical=True):
        p.get_by_label("6-digit code").fill(S["signup_otp"])
        btn(p, "Verify & sign in").click()
        wait_text(p, "Customer admin")
        assert has_text(p, S["biz"])
        tok = p.evaluate("sessionStorage.getItem('qf_admin_token')")
        assert tok, "no session token stored"
        S["token"] = tok
        S["tenant_id"] = env.api.ok("GET", "/api/tenant/me", token=tok)["tenant"]["id"]
    with T.step(A, "reload keeps the admin signed in", p):
        p.reload()
        wait_text(p, "Customer admin")
        assert not has_text(p, "Admin sign-in")


# ==========================================================================================================
# B. Customer-admin: locations, services, licences, hours, staff, dashboard, account
# ==========================================================================================================
def nav(a, label):
    p = a.page
    if a.phone and label in ("Account", "Audit log", "Shop"):
        btn(p, "More", exact=True).click()
        p.get_by_role("dialog", name="More").get_by_role("button", name=label).click()
    else:
        p.locator("nav[aria-label=Main]").filter(visible=True).get_by_role("button", name=label, exact=True).click()


def add_days(iso, n):
    import datetime
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)).isoformat()


def uk_date(iso):
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


def svc_by_name(env, name):
    for s in env.api.ok("GET", "/api/tenant/services", token=env.S["token"])["services"]:
        if s["name"] == name:
            return s
    raise AssertionError(f"service {name} not found")


def wizard_add_service(a, name, mode_label, plan, start, area="B", scan_label=None):
    """Drives the 'New service' wizard: details -> buy a licence (plan, start, pay) -> done."""
    p = a.page
    btn(p, "+ Add service").click()
    wiz = p.locator("div.card").filter(has_text="New service").last
    wiz.get_by_label("Service name").fill(name)
    wiz.get_by_role("radio", name=re.compile("^" + mode_label)).check()
    if scan_label:
        a.scan(area, f"{scan_label} wizard step 1")
    btn(p, re.compile("Next: buy a license")).click()
    wait_text(p, "Choose a plan")
    p.get_by_role("radio", name=re.compile("^" + plan)).click()
    if scan_label:
        a.scan(area, f"{scan_label} buy: plan")
    btn(p, "Continue", exact=True).click()
    wait_text(p, "When should it start?")
    p.get_by_role("radio", name=re.compile("^" + start)).click()
    if scan_label:
        a.scan(area, f"{scan_label} buy: start date")
    btn(p, "Continue", exact=True).click()
    wait_text(p, "How will you pay?")
    if scan_label:
        a.scan(area, f"{scan_label} buy: payment")
    btn(p, re.compile("Confirm & buy")).click()
    wait_text(p, "is ready")
    if scan_label:
        a.scan(area, f"{scan_label} wizard done")
    btn(p, "Done", exact=True).click()
    p.locator(f'.svc-card:has(input[value="{name}"])').wait_for()


def daily(env, svc_id, date):
    r = env.api.ok("GET", f"/api/tenant/services/{svc_id}/daily-config?from={date}&to={date}", token=env.S["token"])["dailyConfig"]
    return r[0] if r else None


def journey_B(env):
    T, S, api, B = env.T, env.S, env.api, "B"
    a = S["admin"]
    p = a.page
    tok, today = S["token"], api.clock_today()
    tomorrow = add_days(today, 1)

    # ---- dashboard + tab navigation ---------------------------------------------------------------------
    with T.step(B, "dashboard shows after sign-in", p, critical=True):
        nav(a, "Dashboard")
        p.get_by_role("heading", level=1, name="Dashboard").wait_for()
        wait_text(p, "Today's tickets")
    a.scan(B, "dashboard", focus=True)
    with T.step(B, "no 'Patients' tab in the navigation", p):
        names = p.locator("nav[aria-label=Main]").filter(visible=True).get_by_role("button").all_inner_texts()
        if a.phone:
            btn(p, "More", exact=True).click()
            names += p.get_by_role("dialog", name="More").get_by_role("button").all_inner_texts()
            a.scan(B, "'More' sheet")
            p.keyboard.press("Escape")
        assert not any("Patients" in n or "Customers" in n for n in names), names
        expected = ["Dashboard", "Locations", "Staff"] + (["Account", "Audit log"] if a.phone or True else [])
        for e in expected:
            assert any(e in n for n in names), f"{e} missing in {names}"
    with T.step(B, "tab navigation reaches Staff, Account, Audit log and back to Dashboard", p):
        for label in ["Staff", "Account", "Audit log", "Dashboard"]:
            nav(a, label)
            p.get_by_role("heading", level=1, name=label, exact=True).wait_for()
            if label != "Dashboard":
                a.scan(B, f"{label} tab (initial)")

    # ---- locations: sole location opens by itself ---------------------------------------------------------
    with T.step(B, "Locations tab opens the only location straight away", p, critical=True):
        nav(a, "Locations")
        p.get_by_label("Location name").wait_for()
        assert p.get_by_label("Location name").input_value() == S["loc1"]
        p.locator('input[value="Blood Test"]').wait_for()
    a.scan(B, "location detail (sole location)", focus=True)

    # ---- schedule the free trial licence --------------------------------------------------------------------
    with T.step(B, "service shows an unscheduled (Available) trial licence", p, critical=True):
        wait_text(p, "Assign dates")
        assert has_text(p, "available") or has_text(p, "Available")
    a.scan(B, "service licences tab (unscheduled licence)")
    with T.step(B, "schedule the licence: Assign dates -> start today -> Confirm", p, critical=True):
        btn(p, "Assign dates").click()
        wait_text(p, "Ends ")
        a.scan(B, "assign dates picker")
        btn(p, "Confirm", exact=True).click()
        p.locator(".cal-layout").wait_for()
        lic = api.ok("GET", f"/api/tenant/services/{svc_by_name(env, 'Blood Test')['id']}/licenses", token=tok)["licenses"][0]
        assert lic["status"] == "active" and lic["start_date"] == today and lic["end_date"] == tomorrow, lic
    S["svc_bt"] = svc_by_name(env, "Blood Test")
    with T.step(B, "header badge shows an Active licence", p):
        wait_text(p, "Active")

    # ---- opening hours through the calendar UI (tomorrow: always editable) -----------------------------------
    with T.step(B, "calendar: pick tomorrow and use 'Set 9-5'", p, critical=True):
        p.locator(f'.cal-day[aria-label^="{uk_date(tomorrow)}"]').click()
        wait_text(p, "Tomorrow,")
        btn(p, "Set 9–5").click()
        wait_text(p, "Saved")
        got = daily(env, S["svc_bt"]["id"], tomorrow)
        assert got and 540 in got["hours"] and 1020 not in got["hours"] and len(got["hours"]) == 16, got
    a.scan(B, "calendar + hours grid")
    with T.step(B, "calendar: tapping a half-hour block opens it and saves", p):
        p.get_by_role("button", name="7:00am", exact=True).click()
        wait_text(p, "Saved")
        assert 420 in daily(env, S["svc_bt"]["id"], tomorrow)["hours"]
    if not a.phone:
        with T.step(B, "calendar: dragging across blocks paints a range", p):
            c1 = p.get_by_role("button", name="5:00pm", exact=True).bounding_box()
            c2 = p.get_by_role("button", name="6:30pm", exact=True).bounding_box()
            p.mouse.move(c1["x"] + c1["width"] / 2, c1["y"] + c1["height"] / 2)
            p.mouse.down()
            p.mouse.move(c2["x"] + c2["width"] / 2, c2["y"] + c2["height"] / 2, steps=8)
            p.mouse.up()
            p.wait_for_timeout(900)
            got = daily(env, S["svc_bt"]["id"], tomorrow)
            assert all(h in got["hours"] for h in (1020, 1050, 1080, 1110)), got
    with T.step(B, "calendar: staff count can be changed and is saved", p):
        p.locator(f"#staff-{S['svc_bt']['id']}").fill("3")
        p.wait_for_timeout(700)
        assert daily(env, S["svc_bt"]["id"], tomorrow)["staff_count"] == 3
    # today's hours: the UI grid only offers 07:00-19:30 and freezes blocks already passed, so (like a fixture) use the API
    api.set_hours(tok, S["svc_bt"], "all", staff=4)

    # ---- locations list: copy patient link ----------------------------------------------------------------------
    with T.step(B, "back to the locations list", p, critical=True):
        p.get_by_role("button", name="Back to locations").click()
        p.get_by_role("heading", level=1, name="Locations").wait_for()
    a.scan(B, "locations list", focus=True)
    with T.step(B, "copy-patient-link icon on the Locations tab copies ?t=<tenantId> link", p):
        icon = p.get_by_role("button", name="Copy the patient page link")
        icon.wait_for()
        icon.click()
        p.get_by_role("button", name="Patient page link copied").wait_for()
        clip = p.evaluate("navigator.clipboard.readText()")
        assert clip == f"{env.urls['customer']}/?t={S['tenant_id']}", clip

    # ---- add a second location ----------------------------------------------------------------------------------
    with T.step(B, "add a location", p, critical=True):
        btn(p, "+ Add location").click()
        p.get_by_label("Location name").fill(S["loc2"])
        a.scan(B, "add location form")
        btn(p, "Add", exact=True).click()
        p.get_by_role("button", name=f"Open {S['loc2']}").wait_for()
        assert p.get_by_role("button", name=f"Open {S['loc1']}").count() == 1

    # ---- add services: appointment (start today), hybrid (decide later + Assign dates), second location --------------
    with T.step(B, "add an Appointment service and buy+start a licence (Day, start today, card)", p, critical=True):
        p.get_by_role("button", name=f"Open {S['loc1']}").click()
        wizard_add_service(a, "Flu Jab", "Appointment", "Day", "Start today", scan_label="appointment service")
    with T.step(B, "add a Hybrid service and buy a licence (Week, decide later)", p, critical=True):
        wizard_add_service(a, "X-Ray", "Hybrid", "Week", "Decide later")
    with T.step(B, "schedule the 'decide later' licence with Assign dates", p, critical=True):
        card = p.locator('.svc-card:has(input[value="X-Ray"])')
        card.get_by_role("tab", name=re.compile("Licences")).click()
        card.get_by_role("button", name="Assign dates").click()
        card.get_by_role("button", name="Confirm", exact=True).click()
        card.locator(".cal-layout").wait_for()
        lic = api.ok("GET", f"/api/tenant/services/{svc_by_name(env, 'X-Ray')['id']}/licenses", token=tok)["licenses"][0]
        assert lic["status"] == "active" and lic["end_date"] == add_days(today, 6), lic
    with T.step(B, "add a Queue service through the wizard and leave its licence unscheduled", p, critical=True):
        wizard_add_service(a, "Dressings", "Queue", "Day", "Decide later")
    a.scan(B, "location with four services")
    with T.step(B, "second location: add a Hybrid service (Day, start today)", p, critical=True):
        p.get_by_role("button", name="Back to locations").click()
        p.get_by_role("button", name=f"Open {S['loc2']}").click()
        wait_text(p, "No services here yet")
        wizard_add_service(a, "Vaccines", "Hybrid", "Day", "Start today")
    with T.step(B, "services of all modes exist with the right modes", p):
        modes = {s["name"]: s["mode"] for s in api.ok("GET", "/api/tenant/services", token=tok)["services"]}
        assert modes == {"Blood Test": "queue", "Flu Jab": "appointment", "X-Ray": "hybrid", "Vaccines": "hybrid", "Dressings": "queue"}, modes
    # today's hours for every service (fixture, see note above); hybrid: 2 booking + 2 walk-in staff of 4
    S["svc"] = {}
    for s in api.ok("GET", "/api/tenant/services", token=tok)["services"]:
        S["svc"][s["name"]] = s
        if s["name"] not in ("Blood Test", "Dressings"):
            api.set_hours(tok, s, "all", staff=4, booking=2, walkin=2)
    S["locs"] = {l["name"]: l for l in api.ok("GET", "/api/tenant/locations", token=tok)["locations"]}

    # ---- dashboard: Today panel -------------------------------------------------------------------------------------
    with T.step(B, "dashboard Today panel defaults to 'All services'", p, critical=True):
        nav(a, "Dashboard")
        panel = p.locator("section[aria-label='Today, day by day']")
        panel.wait_for()
        sel = panel.get_by_label("Service")
        assert sel.input_value() == "__all__", sel.input_value()
        assert sel.locator("option").first.inner_text() == "All services"
        panel.locator(".td-kpi").first.wait_for()
    a.scan(B, "dashboard Today panel (all services)")
    with T.step(B, "Today panel lets you pick one service", p):
        panel = p.locator("section[aria-label='Today, day by day']")
        sel = panel.get_by_label("Service")
        opts = sel.locator("option").all_inner_texts()
        assert len(opts) == 6 and opts[1].endswith("Blood Test"), opts
        sel.select_option(index=1)
        assert sel.input_value() != "__all__"
        panel.locator(".td-kpi").first.wait_for()
        assert not panel.locator(".td-err").count(), panel.inner_text()
        sel.select_option(label=[o for o in opts if o.endswith("Dressings")][0])
        panel.get_by_text("isn't licensed for today").wait_for()
        sel.select_option(index=0)
        assert sel.input_value() == "__all__"
    a.scan(B, "dashboard Today panel (one service)")

    # ---- staff ---------------------------------------------------------------------------------------------------------
    S["staff1"] = f"e2e-{RUN}-{env.vp}-sam@example.com"
    S["staff2"] = f"e2e-{RUN}-{env.vp}-ina@example.com"
    with T.step(B, "Staff tab: add an active staff member", p, critical=True):
        nav(a, "Staff")
        btn(p, "+ Add staff member").click()
        p.get_by_label("First name").fill("Sam")
        p.get_by_label("Last name").fill("Staff")
        p.get_by_label("Email address").fill(S["staff1"])
        a.scan(B, "add staff form")
        btn(p, "Add", exact=True).click()
        wait_text(p, S["staff1"])
    with T.step(B, "Staff tab: add a second member, then Disable, Enable, Disable", p):
        btn(p, "+ Add staff member").click()
        p.get_by_label("First name").fill("Ina")
        p.get_by_label("Last name").fill("Inactive")
        p.get_by_label("Email address").fill(S["staff2"])
        btn(p, "Add", exact=True).click()
        wait_text(p, S["staff2"])
        row = (p.locator(".list-card") if a.phone else p.locator("tbody tr")).filter(has_text=S["staff2"]).filter(visible=True).first
        row.get_by_role("button", name="Disable").click()
        row.get_by_text("Inactive", exact=True).wait_for()
        row.get_by_role("button", name="Enable").click()
        row.get_by_text("Active", exact=True).wait_for()
        row.get_by_role("button", name="Disable").click()
        row.get_by_text("Inactive", exact=True).wait_for()
        rows = api.ok("GET", "/api/tenant/staff", token=tok)["staff"]
        assert {r["email"]: r["active"] for r in rows} == {S["staff1"]: True, S["staff2"]: False}, rows
    a.scan(B, "staff list", focus=True)
    with T.step(B, "Staff tab shows the kiosk link for the staff app", p):
        assert has_text(p, env.urls["staff"], exact=True)

    # ---- account --------------------------------------------------------------------------------------------------------
    with T.step(B, "Account tab: no 'only joinable from the clinic' setting", p):
        nav(a, "Account")
        p.get_by_role("heading", level=1, name="Account").wait_for()
        wait_text(p, "Delete account")
        for t in ["Only joinable from the clinic", "Joining the queue", "joinable"]:
            assert not has_text(p, t), t
    with T.step(B, "Account tab: save the business website", p):
        p.get_by_label("Website").fill("https://example.org/e2e-clinic")
        btn(p, "Save", exact=True).click()
        wait_text(p, "Saved.")
        assert api.ok("GET", "/api/tenant/me", token=tok)["tenant"]["website_url"] == "https://example.org/e2e-clinic"
    with T.step(B, "Account tab lists the licences that were bought", p):
        assert has_text(p, "Licenses (5)"), dump_text(p)
        for n in ["Blood Test", "Flu Jab", "X-Ray", "Vaccines", "Dressings"]:
            assert has_text(p, n), n
    a.scan(B, "account tab", focus=True)
    with T.step(B, "Audit log records what happened", p):
        nav(a, "Audit log")
        wait_text(p, "Activity")
        wait_text(p, f'Location "{S["loc2"]}" added')
        wait_text(p, "Staff user added: Sam Staff")
    a.scan(B, "audit log")
    with T.step(B, "dashboard still loads after all changes", p):
        nav(a, "Dashboard")
        wait_text(p, "Today's tickets")


# ==========================================================================================================
# C. Patient app
# ==========================================================================================================
def poke(p):
    """Make the patient page poll right now instead of waiting for its 10s timer."""
    p.evaluate("window.dispatchEvent(new Event('focus'))")


def choice(p, name):
    return p.locator(".choices button").filter(has_text=name).first


def ticket_number(p):
    return p.locator(".ticket-band-num").inner_text().strip()


def patient_to_service(env, a, location, service):
    """Walk the chat: (location chooser) -> service list -> chosen service."""
    p = a.page
    if location:
        wait_text(p, "Which location are you at?")
        choice(p, location).click()
    wait_text(p, "Which service do you need today?")
    choice(p, service).click()


def journey_C(env):
    T, S, api, C = env.T, env.S, env.api, "C"
    cust, tid, biz = env.urls["customer"], S["tenant_id"], S["biz"]
    fx = env.fx
    late_night = time.localtime().tm_hour == 0
    # ---- multi-location chooser ---------------------------------------------------------------------------------
    p1 = env.actor()
    p = p1.page
    with T.step(C, "multi-location business: location chooser lists every location as open", p, critical=True):
        p1.goto(f"{cust}/?t={tid}")
        wait_text(p, f"Welcome to {biz}.")
        wait_text(p, "Which location are you at?")
        for loc in (S["loc1"], S["loc2"]):
            b = p.get_by_role("button", name=re.compile(re.escape(loc) + ".*Open now"))
            b.wait_for()
            assert b.is_enabled()
        assert p.get_by_role("heading", level=1).inner_text().strip() == biz
    p1.scan(C, "patient: location chooser", focus=True)
    with T.step(C, "choosing a location lists the open services", p, critical=True):
        choice(p, S["loc1"]).click()
        wait_text(p, "Which service do you need today?")
        names = p.locator(".choices button").all_inner_texts()
        assert [n.strip() for n in names] == ["Blood Test", "Flu Jab", "X-Ray"], names
    p1.scan(C, "patient: service list")
    with T.step(C, "queue service: 'Ready to join the queue?'", p, critical=True):
        choice(p, "Blood Test").click()
        wait_text(p, "Ready to join the queue?")
    p1.scan(C, "patient: ready to join")
    with T.step(C, "join the queue as a walk-in -> ticket + position shown", p, critical=True):
        choice(p, "Join the queue now").click()
        p.locator(".ticket-band-num").wait_for()
        S["t1"] = ticket_number(p)
        assert re.fullmatch(r"BT-\d{3}", S["t1"]), S["t1"]
        assert p.locator(".pos-num").inner_text().strip() == "1"
        assert has_text(p, "in line") and has_text(p, "Your ticket · Blood Test")
        wait_text(p, "Live")
        S["tok1"] = re.search(r"[?&]k=([^&]+)", p.url).group(1)
    p1.scan(C, "patient: ticket (waiting in queue)", focus=True)
    with T.step(C, "ticket screen offers 'Get updates on WhatsApp' and 'Leave the queue'", p):
        assert btn(p, "Get updates on WhatsApp").is_visible()
        assert btn(p, "Leave the queue").is_visible()
    with T.step(C, "reloading the page restores the ticket", p):
        p.reload()
        p.locator(".ticket-band-num").wait_for()
        assert ticket_number(p) == S["t1"]
    with T.step(C, "reopening the plain link (no ?k) in a new tab on the same phone restores the ticket", p):
        p2 = p1.ctx.new_page()
        p2.goto(f"{cust}/?t={tid}")
        p2.locator(".ticket-band-num").wait_for()
        assert p2.locator(".ticket-band-num").inner_text().strip() == S["t1"]
        p2.close()
    with T.step(C, "the ticket link works on another device", p):
        other = env.actor()
        other.goto(f"{cust}/?t={tid}&k={S['tok1']}")
        other.page.locator(".ticket-band-num").wait_for()
        assert ticket_number(other.page) == S["t1"]
        other.close()
    with T.step(C, "unknown ticket link shows a clear 'can't find your ticket' message", p):
        other = env.actor()
        with other.mon.expect("404", "Failed to load resource"):
            other.goto(f"{cust}/?t={tid}&k=aaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            wait_text(other.page, "We can't find your ticket")
        assert btn(other.page, "Start again").is_visible()
        other.scan(C, "patient: unknown ticket", allow=("404", "Failed to load resource"))
        other.close()
    with T.step(C, "unknown business shows 'We couldn't find that business'", p):
        other = env.actor()
        with other.mon.expect("404", "Failed to load resource"):
            other.goto(f"{cust}/?t=00000000-0000-0000-0000-000000000000")
            wait_text(other.page, "We couldn't find that business")
        other.close()
    with T.step(C, "link without a business asks for a business ID (and has a labelled field)", p):
        other = env.actor()
        other.goto(f"{cust}/")
        other.page.get_by_label("Business ID").wait_for()
        other.scan(C, "patient: no business in link")
        other.close()

    # ---- second patient: position 2, WhatsApp, leave -------------------------------------------------------------
    p2a = env.actor()
    p = p2a.page
    with T.step(C, "location-scoped link (?l=) skips the chooser; second walk-in is 2 in line", p, critical=True):
        p2a.goto(f"{cust}/?t={tid}&l={S['locs'][S['loc1']]['id']}")
        wait_text(p, "Which service do you need today?")
        assert not has_text(p, "Which location are you at?")
        choice(p, "Blood Test").click()
        choice(p, "Join the queue now").click()
        p.locator(".ticket-band-num").wait_for()
        S["t2"] = ticket_number(p)
        assert S["t2"] != S["t1"]
        assert p.locator(".pos-num").inner_text().strip() == "2", p.locator(".pos-num").inner_text()
        S["tok2"] = re.search(r"[?&]k=([^&]+)", p.url).group(1)
    with T.step(C, "first patient is still 1 in line after the second joined", p1.page):
        poke(p1.page)
        p1.page.wait_for_function("document.querySelector('.pos-num') && document.querySelector('.pos-num').innerText.trim() === '1'")
    with T.step(C, "'Get updates on WhatsApp' records the request and shows a confirmation", p):
        btn(p, "Get updates on WhatsApp").click()
        wait_text(p, "Noted.")
        d = api.ok("GET", f"/api/public/ticket/{S['tok2']}")
        assert d["whatsappUpdatesRequested"] is True, d
        assert not has_text(p, "Get updates on WhatsApp")
    p2a.scan(C, "patient: ticket after WhatsApp request")
    with T.step(C, "alert-sound switch can be toggled", p):
        sw = p.get_by_role("switch")
        sw.click()
        assert sw.get_attribute("aria-checked") == "true"
        sw.click()
    with T.step(C, "leave the queue: asks to confirm, then releases the place", p, critical=False):
        btn(p, "Leave the queue").click()
        wait_text(p, "Leave the queue?")
        p2a.scan(C, "patient: confirm leaving")
        btn(p, "Yes, leave").click()
        wait_text(p, "You've left the queue")
        d = api.ok("GET", f"/api/public/ticket/{S['tok2']}")
        assert d["state"] == "cancelled", d
    p2a.scan(C, "patient: left the queue")
    with T.step(C, "'Start again' after leaving restarts the chat", p):
        btn(p, "Start again").click()
        wait_text(p, "Which service do you need today?")
    with T.step(C, "opening the link of a ticket that was left shows it has ended", p):
        p.goto(f"{cust}/?t={tid}&k={S['tok2']}")
        wait_text(p, "You've left the queue")

    # ---- booking + check-in ----------------------------------------------------------------------------------------
    p3 = env.actor()
    p = p3.page
    with T.step(C, "appointment service offers time slots", p, critical=True):
        p3.goto(f"{cust}/?t={tid}")
        patient_to_service(env, p3, S["loc1"], "Flu Jab")
        wait_text(p, "Pick a time")
        slots = [t.strip() for t in p.locator(".choices button").all_inner_texts()]
        assert any(re.fullmatch(r"\d{1,2}:\d{2}(am|pm) today", s) for s in slots), slots
    p3.scan(C, "patient: time slots")
    with T.step(C, "book a slot -> appointment ticket with its time", p, critical=True):
        first = [b for b in p.locator(".choices button").all() if re.fullmatch(r"\d{1,2}:\d{2}(am|pm) today", b.inner_text().strip())][0]
        S["slot_label"] = first.inner_text().strip().replace(" today", "")
        first.click()
        p.locator(".ticket-band-num").wait_for()
        S["t3"] = ticket_number(p)
        assert re.fullmatch(r"FJ-\d{3}", S["t3"]), S["t3"]
        assert p.locator(".pos-num").inner_text().strip() == S["slot_label"], (p.locator(".pos-num").inner_text(), S["slot_label"])
        assert has_text(p, "Your ticket · Flu Jab")
        assert btn(p, "Cancel my appointment").is_visible()
        S["tok3"] = re.search(r"[?&]k=([^&]+)", p.url).group(1)
    p3.scan(C, "patient: booked appointment (not yet checked in)", focus=True)
    with T.step(C, "booked patient can check in with 'I've arrived'", p):
        btn(p, "I've arrived").click()
        wait_text(p, "You're checked in")
        assert api.ok("GET", f"/api/public/ticket/{S['tok3']}")["arrived"] is True
    p3.scan(C, "patient: checked in")
    with T.step(C, "checked-in state survives a reload", p):
        p.reload()
        wait_text(p, "You're checked in")

    # ---- hybrid + second location ---------------------------------------------------------------------------------
    p4 = env.actor()
    p = p4.page
    with T.step(C, "hybrid service offers both 'Join the queue now' and 'Book an appointment'", p):
        p4.goto(f"{cust}/?t={tid}")
        patient_to_service(env, p4, S["loc1"], "X-Ray")
        wait_text(p, "How would you like to be seen?")
        assert choice(p, "Join the queue now").is_visible() and choice(p, "Book an appointment").is_visible()
    p4.scan(C, "patient: hybrid choice")
    with T.step(C, "second location with a single open service skips the service list", p):
        p4.goto(f"{cust}/?t={tid}")
        wait_text(p, "Which location are you at?")
        choice(p, S["loc2"]).click()
        wait_text(p, "How would you like to be seen?")
        assert not has_text(p, "Which service do you need today?")
        assert has_text(p, "Vaccines")
    with T.step(C, "'Book an appointment' shows times and a way to pick another time", p):
        choice(p, "Book an appointment").click()
        wait_text(p, "Pick a time")
        assert p.locator(".choices button").count() >= 2

    # ---- single-location business ----------------------------------------------------------------------------------
    p5 = env.actor()
    p = p5.page
    with T.step(C, "single-location business: no chooser, straight to joining", p):
        p5.goto(f"{cust}/?t={fx['single']['id']}")
        wait_text(p, "Ready to join the queue?")
        assert has_text(p, f"Welcome to {fx['single']['name']}.")
        assert not has_text(p, "Which location are you at?")
        assert choice(p, "Join the queue now").is_visible()
        assert has_text(p, "Walk-in Desk")  # header subtitle names the service
    p5.scan(C, "patient: single-location join")

    # ---- closed / after hours / no licence -------------------------------------------------------------------------
    def closed_case(name, tenant, welcome, text, website, label):
        a = env.actor()
        p = a.page
        with T.step(C, name, p):
            a.goto(f"{cust}/?t={tenant['id']}")
            wait_text(p, welcome)
            wait_text(p, text)
            link = p.locator(".choices button").filter(has_text="Visit our website")
            assert (link.count() == 1) == website, f"website link count {link.count()}, expected {website}"
            if website:
                assert has_text(p, "See opening hours")
                p.evaluate("window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; }; true")
                link.first.click()
                opened = p.evaluate("window.__opened")
                assert opened and opened[0][0] == "https://example.org/e2e-clinic" and "noopener" in (opened[0][2] or ""), opened
        a.scan(C, label)
        return a
    if late_night:
        T.skip(C, "closed / after-hours states", "needs the local time to be after 00:30 (fixture hours end at 00:30)")
    else:
        closed_case("after hours (last opening block has ended): welcome to the location + 'Visit our website'", fx["closed"],
                    "Welcome to e2e Closed Site.", "We're not open right now", True, "patient: after hours with website")
        closed_case("no licence scheduled: welcome to the location + 'Visit our website'", fx["nolicence"],
                    "Welcome to e2e Unlicensed Site.", "Nothing is available here today.", True, "patient: no licence with website")
        closed_case("after hours without a business website: no website link is offered", fx["nosite"],
                    "Welcome to e2e Nosite Site.", "We're not open right now", False, "patient: after hours without website")
        ac = env.actor()
        p = ac.page
        with T.step(C, "location chooser with every location closed: disabled locations + 'Visit our website'", p):
            ac.goto(f"{cust}/?t={fx['allclosed']['id']}")
            wait_text(p, "We're not open right now")
            for loc in ("e2e North", "e2e South"):
                b = p.get_by_role("button", name=re.compile(re.escape(loc) + ".*Not available"))
                b.wait_for()
                assert b.is_disabled()
            assert p.locator(".choices button").filter(has_text="Visit our website").count() == 1
        ac.scan(C, "patient: all locations closed")
        # real "closed" reason: the service has hours for later only? covered by fixture hours [00:00,00:30] above


# ==========================================================================================================
# D. Staff kiosk
# ==========================================================================================================
def staff_sign_in(a, email, S, pick_location="e2e Riverside"):
    p = a.page
    p.get_by_label("Email address").fill(email)
    btn(p, "Email me a code").click()
    wait_text(p, "Check your email")
    wait_text(p, "Demo code:")
    code = p.locator(".help-card strong.mono").inner_text().strip()
    p.get_by_label("Digit 1 of 6").click()
    p.keyboard.type(code, delay=30)
    btn(p, "Sign in", exact=True).click()
    wait_text(p, "Where are you working today?")
    if pick_location and has_text(p, pick_location):
        p.get_by_role("button", name=pick_location).click()


def staff_tab(a, label):
    """phone: switch tab (With you / Waiting / Seen)"""
    if a.phone:
        a.page.get_by_role("tab", name=re.compile("^" + label)).click()


def journey_D(env):
    T, S, api, D = env.T, env.S, env.api, "D"
    tid, staff_url = S["tenant_id"], env.urls["staff"]
    # make sure there is something to call even if C did not run
    bt = S["svc"]["Blood Test"]
    for _ in range(2):
        api.join_walkin(tid, bt["id"])
    sa = env.actor()
    S["staff_actor"] = sa
    p = sa.page
    with T.step(D, "staff app shows the email sign-in", p, critical=True):
        sa.goto(staff_url)
        wait_text(p, "Email me a code")
        p.get_by_role("heading", level=1, name="Sign in").wait_for()
    sa.scan(D, "staff: sign-in", focus=True)
    with T.step(D, "sign-in rejects something that isn't an email address", p):
        p.get_by_label("Email address").fill("not-an-email")
        btn(p, "Email me a code").click()
        wait_text(p, "doesn't look like an email address")
    with T.step(D, "inactive (disabled) staff cannot sign in", p):
        p.get_by_label("Email address").fill(S["staff2"])
        btn(p, "Email me a code").click()
        wait_text(p, "Check your email")
        assert not has_text(p, "Demo code:"), "a code was issued to a disabled account"
        p.get_by_label("Digit 1 of 6").click()
        p.keyboard.type("123456", delay=20)
        with sa.mon.expect("401", "Failed to load resource"):
            btn(p, "Sign in", exact=True).click()
            wait_text(p, "That code didn't work")
        assert not has_text(p, "Where are you working today?")
        sa.scan(D, "staff: code step with error")
        p.get_by_role("button", name="Wrong email? Change it").click()
        wait_text(p, "Email me a code")
    with T.step(D, "active staff member signs in with the emailed (demo) code and picks a location", p, critical=True):
        staff_sign_in(sa, S["staff1"], S, pick_location=None)
        for loc in (S["loc1"], S["loc2"]):
            p.get_by_role("button", name=loc).wait_for()
    sa.scan(D, "staff: location picker", focus=True)
    with T.step(D, "start of shift: room is mandatory and services must be ticked", p, critical=True):
        p.get_by_role("button", name=S["loc1"]).click()
        p.get_by_label("Room or desk").wait_for()
        start = btn(p, "Start", exact=True)
        assert start.is_disabled()
        wait_text(p, "Enter your room or desk to start.")
        assert not has_text(p, "Same as last time"), "quick start shown on first ever shift"
        p.get_by_label("Room or desk").fill("Room 2")
        assert start.is_disabled()
        wait_text(p, "Tick at least one service to start.")
        for svc in ("Blood Test", "Flu Jab", "X-Ray"):
            p.locator("label.opt").filter(has_text=svc).click()
        wait_text(p, "For X-Ray I'll look after:")
        assert start.is_enabled()
    sa.scan(D, "staff: start of shift", focus=True)
    with T.step(D, "Start opens the working screen with the team name, location and services", p, critical=True):
        start.click()
        p.locator(".kiosk-bar").wait_for()
        txt = p.locator(".kiosk-bar").inner_text()
        assert "Blood Test" in txt and S["loc1"] in txt and "Sam Staff" in txt, txt
    if not sa.phone:
        wait_text(p, "With you now")
    with T.step(D, "waiting list shows walk-ins with their service and booked patients with a check-in badge", p):
        if sa.phone:
            staff_tab(sa, "Waiting")
        p.locator(".wrow").first.wait_for()
        if S.get("t1"):
            row = p.locator(".wrow").filter(has_text=S["t1"]).first
            row.wait_for()
            assert "Blood Test" in row.inner_text() and "Walk-in" in row.inner_text(), row.inner_text()
        if S.get("t3"):
            row = p.locator(".wrow").filter(has_text=S["t3"]).first
            row.wait_for()
            r = row.inner_text()
            assert "Flu Jab" in r and "Checked in" in r and "Appointment" in r, r
        assert p.locator(".wrow .badge-next").count() == 1
    sa.scan(D, "staff: waiting list", focus=True)

    # ---- call next / return to queue / finish ---------------------------------------------------------------------------
    with T.step(D, "'Call next patient' calls the first in line and shows them only under 'With you now'", p, critical=True):
        staff_tab(sa, "With you")
        callbtn = p.locator(".call-btn")
        callbtn.wait_for()
        S["called"] = callbtn.locator(".mono").inner_text().strip()
        callbtn.click()
        p.locator(".scard").wait_for()
        assert p.locator(".scard-num").inner_text().strip() == S["called"]
        assert p.get_by_role("heading", name="Waiting", exact=True).count() == 0 and p.get_by_role("tab", name=re.compile("^Waiting")).count() == 0, "waiting list still shown while serving"
        assert p.locator(".wrow").count() == 0
        assert btn(p, "Sign out").is_disabled(), "sign out must be blocked while serving"
    sa.scan(D, "staff: with a patient", focus=True)
    with T.step(D, "'Return to queue' puts the patient back in the waiting list", p, critical=True):
        btn(p, "Return to queue").click()
        p.locator(".scard").wait_for(state="detached")   # (phones jump to the Waiting tab by themselves)
        staff_tab(sa, "Waiting")
        p.locator(".wrow").filter(has_text=S["called"]).first.wait_for()
        assert p.locator(".scard").count() == 0
    with T.step(D, "call a specific patient from the list, call again, then Finish", p, critical=True):
        p.locator(".wrow").filter(has_text=S["called"]).first.get_by_role("button", name=f"Call {S['called']}").click()
        p.locator(".scard").wait_for()
        assert p.locator(".scard-num").inner_text().strip() == S["called"]
        assert "Room 2" in p.locator(".scard").inner_text()
        btn(p, "Call again").click()
        p.get_by_text(f"Called {S['called']} again.").first.wait_for(state="attached")
        btn(p, "Finish this patient").click()
        p.locator(".scard").wait_for(state="detached")
        assert p.locator(".scard").count() == 0
    with T.step(D, "finished patient is listed under 'Seen today' as Completed", p):
        if sa.phone:
            staff_tab(sa, "Seen")
            assert p.get_by_role("tab", name=re.compile("^Today")).count() == 0, "Queue/Today toggle must not show on phones"
        else:
            p.get_by_role("tab", name="Today").click()
            p.locator("section.today").wait_for()
            p.get_by_role("heading", name="Seen today").wait_for()
        row = p.locator(".seen-row").filter(has_text=S["called"]).first
        row.wait_for()
        assert "Completed" in row.inner_text() and "Sam Staff" in row.inner_text() and "Room 2" in row.inner_text(), row.inner_text()
    sa.scan(D, "staff: seen today" + ("" if sa.phone else " + Today panel"), focus=True)
    if not sa.phone:
        with T.step(D, "Queue|Today toggle switches back to the queue view", p):
            p.get_by_role("tab", name="Queue").click()
            wait_text(p, "With you now")
            assert p.locator("section.today").count() == 0
    with T.step(D, "room box is editable, remembered on the device, and used for the next call", p, critical=True):
        room = p.get_by_label("Room or desk")
        room.fill("Room 3")
        assert p.evaluate("localStorage.getItem('qb_staff_room')") == '"Room 3"'
        staff_tab(sa, "With you")
        p.locator(".call-btn").click()
        p.locator(".scard").wait_for()
        assert "Room 3" in p.locator(".scard").inner_text(), p.locator(".scard").inner_text()
        S["called2"] = p.locator(".scard-num").inner_text().strip()
        btn(p, "Finish this patient").click()
        p.locator(".scard").wait_for(state="detached")
    with T.step(D, "clearing the room box blocks calling and explains why", p):
        p.get_by_label("Room or desk").fill("")
        wait_text(p, "Enter your room or desk to call patients.")
        staff_tab(sa, "With you")
        cb = p.locator(".call-btn")
        if cb.count():
            assert cb.is_disabled()
        p.get_by_label("Room or desk").fill("Room 3")
    with T.step(D, "sign out and back in: 'Same as last time' quick start", p, critical=True):
        btn(p, "Sign out").click()
        wait_text(p, "Email me a code")
        staff_sign_in(sa, S["staff1"], S)
        wait_text(p, "Ready to start?")
        wait_text(p, "Same as last time")
        assert has_text(p, "Room 3") and has_text(p, "Blood Test")
    sa.scan(D, "staff: quick start (same as last time)", focus=True)
    with T.step(D, "quick start button starts the shift in the remembered room", p, critical=True):
        btn(p, "Start in Room 3").click()
        p.locator(".kiosk-bar").wait_for()
        assert p.get_by_label("Room or desk").input_value() == "Room 3"
    with T.step(D, "disabling a staff member while they are signed in signs them out of the kiosk", p):
        zed = api.ok("POST", "/api/tenant/staff", dict(firstName="Zed", lastName="Temp", email=f"e2e-{RUN}-{env.vp}-zed@example.com"), S["token"])["staff"]
        za = env.actor()
        za.goto(staff_url)
        staff_sign_in(za, zed["email"], S)
        za.page.get_by_label("Room or desk").fill("Room 9")
        za.page.locator("label.opt").filter(has_text="Blood Test").click()
        btn(za.page, "Start", exact=True).click()
        za.page.locator(".kiosk-bar").wait_for()
        api.ok("PATCH", f"/api/tenant/staff/{zed['id']}", dict(active=False), S["token"])
        with za.mon.expect("401", "Failed to load resource"):
            za.page.get_by_role("button", name="Email me a code").wait_for(timeout=14000)
        za.close()
    with T.step(D, "staff session survives a reload (still signed in; asks for location and start again)", p):
        p.reload()
        p.get_by_role("button", name=S["loc1"]).click()   # location is not remembered across a reload
        wait_text(p, "Ready to start?")
        btn(p, "Start in Room 3").click()
        p.locator(".kiosk-bar").wait_for()


# ==========================================================================================================
# E. Cross-app: patient joins -> staff sees -> staff calls -> patient sees called -> staff finishes -> patient sees done
# ==========================================================================================================
def ribbon_walkins(env):
    d = env.api.ok("GET", f"/api/tenant/today?serviceId={env.S['svc']['Blood Test']['id']}", token=env.S["token"])
    return sum(b["walkIn"] for b in d["blocks"])


def journey_E(env):
    T, S, api, E = env.T, env.S, env.api, "E"
    cust, tid = env.urls["customer"], S["tenant_id"]
    sa, adm = S["staff_actor"], S["admin"]
    sp = sa.page
    # clean slate for the staff screen
    if sp.locator(".scard").count():
        btn(sp, "Finish this patient").click()
        sp.locator(".scard").wait_for(state="detached")
    # walk-in patient (UI)
    e1 = env.actor()
    with T.step(E, "walk-in patient joins the Blood Test queue from their phone", e1.page, critical=True):
        e1.goto(f"{cust}/?t={tid}")
        patient_to_service(env, e1, S["loc1"], "Blood Test")
        choice(e1.page, "Join the queue now").click()
        e1.page.locator(".ticket-band-num").wait_for()
        S["e1"] = ticket_number(e1.page)
    # booked patient (UI)
    e2 = env.actor()
    with T.step(E, "booked patient books Flu Jab and checks in", e2.page, critical=True):
        e2.goto(f"{cust}/?t={tid}")
        patient_to_service(env, e2, S["loc1"], "Flu Jab")
        wait_text(e2.page, "Pick a time")
        [b for b in e2.page.locator(".choices button").all() if re.fullmatch(r"\d{1,2}:\d{2}(am|pm) today", b.inner_text().strip())][0].click()
        e2.page.locator(".ticket-band-num").wait_for()
        S["e2"] = ticket_number(e2.page)
        btn(e2.page, "I've arrived").click()
        wait_text(e2.page, "You're checked in")
    with T.step(E, "staff screen picks up both patients by itself (no manual refresh)", sp, critical=True):
        if sa.phone:
            staff_tab(sa, "Waiting")
        sp.locator(".wrow").filter(has_text=S["e1"]).first.wait_for(timeout=16000)
        sp.locator(".wrow").filter(has_text=S["e2"]).first.wait_for(timeout=16000)
    with T.step(E, "staff list shows the service for each patient and a checked-in badge for the booked one", sp):
        r1 = sp.locator(".wrow").filter(has_text=S["e1"]).first.inner_text()
        r2 = sp.locator(".wrow").filter(has_text=S["e2"]).first.inner_text()
        assert "Blood Test" in r1 and "Walk-in" in r1, r1
        assert "Flu Jab" in r2 and "Checked in" in r2 and "Appointment" in r2, r2
    sa.scan(E, "staff: list with patients from the patient app")
    with T.step(E, "customer-admin dashboard shows the new tickets (booked one as 'Checked in')", adm.page):
        ap = adm.page
        nav(adm, "Dashboard")
        btn(ap, "Refresh").click()
        row = (ap.locator(".t-card") if adm.phone else ap.locator("tbody tr")).filter(has_text=S["e2"]).filter(visible=True).first
        row.wait_for()
        assert "Checked in" in row.inner_text(), row.inner_text()
        row1 = (ap.locator(".t-card") if adm.phone else ap.locator("tbody tr")).filter(has_text=S["e1"]).filter(visible=True).first
        assert "Waiting" in row1.inner_text(), row1.inner_text()
    with T.step(E, "staff calls the walk-in patient", sp, critical=True):
        sp.locator(".wrow").filter(has_text=S["e1"]).first.get_by_role("button", name=f"Call {S['e1']}").click()
        sp.locator(".scard").wait_for()
        assert sp.locator(".scard-num").inner_text().strip() == S["e1"]
        assert "Blood Test" in sp.locator(".scard").inner_text()
    with T.step(E, "patient's page switches to 'It's your turn' with the room", e1.page, critical=True):
        room = sp.get_by_label("Room or desk").input_value()
        poke(e1.page)
        wait_text(e1.page, "It's your turn")
        wait_text(e1.page, f"Please go to {room}")
        assert S["e1"] in e1.page.title() and "called" in e1.page.title().lower(), e1.page.title()
        assert not has_text(e1.page, "Leave the queue")
    e1.scan(E, "patient: called", focus=True)
    with T.step(E, "staff finishes -> patient's page shows the visit is finished", sp, critical=True):
        btn(sp, "Finish this patient").click()
        sp.locator(".scard").wait_for(state="detached")
        poke(e1.page)
        wait_text(e1.page, "Your visit is finished")
    e1.scan(E, "patient: finished")
    with T.step(E, "booked patient: staff calls from the list, patient sees called, then finished", e2.page):
        if sa.phone:
            staff_tab(sa, "Waiting")
        sp.locator(".wrow").filter(has_text=S["e2"]).first.get_by_role("button", name=f"Call {S['e2']}").click()
        sp.locator(".scard").wait_for()
        poke(e2.page)
        wait_text(e2.page, "It's your turn")
        wait_text(e2.page, f"Please go to {room}")
        btn(sp, "Finish this patient").click()
        sp.locator(".scard").wait_for(state="detached")
        poke(e2.page)
        wait_text(e2.page, "Your visit is finished")
    with T.step(E, "patient page also updates by itself within the poll interval (no manual nudge)", e1.page):
        # new walk-in, called by staff: the open patient page must flip without poke()
        e3 = env.actor()
        used0 = ribbon_walkins(env)
        e3.goto(f"{cust}/?t={tid}")
        patient_to_service(env, e3, S["loc1"], "Blood Test")
        choice(e3.page, "Join the queue now").click()
        e3.page.locator(".ticket-band-num").wait_for()
        n3 = ticket_number(e3.page)
        S["ribbon"] = (used0, ribbon_walkins(env))
        if sa.phone:
            staff_tab(sa, "Waiting")
        sp.locator(".wrow").filter(has_text=n3).first.get_by_role("button", name=f"Call {n3}").click(timeout=16000)
        sp.locator(".scard").wait_for()
        wait_text(e3.page, "It's your turn", timeout=14000)
        btn(sp, "Finish this patient").click()
        sp.locator(".scard").wait_for(state="detached")
    with T.step(E, "dashboard counts the completed tickets", adm.page):
        ap = adm.page
        btn(ap, "Refresh").click()
        ap.wait_for_timeout(600)
        done = api.ok("GET", f"/api/tenant/dashboard/stats?date={api.clock_today()}", token=S["token"])["stats"]
        assert done["completed"] >= 4, done
        row = (ap.locator(".t-card") if adm.phone else ap.locator("tbody tr")).filter(has_text=S["e1"]).filter(visible=True).first
        assert "Completed" in row.inner_text(), row.inner_text()
    with T.step(E, "a walk-in who joins from the patient app uses up a walk-in place in the Today ribbon", adm.page):
        used0, used1 = S["ribbon"]
        assert used1 == used0 + 1, (f"walk-in places used went {used0} -> {used1} after a patient joined the queue "
                                    f"(patient app sends hourBlock=null, so the ticket belongs to no half-hour block)")


# ==========================================================================================================
# main
# ==========================================================================================================
def journey_F(env):
    """System-admin console (admin/): see e2e/sysadmin.py. Independent of A-E: its fixtures are written straight to the test DB."""
    sys.modules.setdefault("e2e", sys.modules[__name__])   # sysadmin.py does `import e2e` - give it this running module, not a second copy
    sys.path.insert(0, str(HERE))
    import sysadmin
    sysadmin.run(env)


def make_fixture_tenants(env):
    """Read-only tenants for the patient app's 'not open / no licence' states (shared by both viewports)."""
    api = env.api
    site = "https://example.org/e2e-clinic"
    fx = {}
    fx["single"] = api.make_tenant(f"e2e-{RUN}-Single", ["e2e Single Site"], [("Walk-in Desk", "queue", 0)], website=site)
    fx["closed"] = api.make_tenant(f"e2e-{RUN}-Closed", ["e2e Closed Site"], [("Walk-in Desk", "queue", 0)], website=site, hours=[0, 30])
    fx["nolicence"] = api.make_tenant(f"e2e-{RUN}-NoLicence", ["e2e Unlicensed Site"], [("Walk-in Desk", "queue", 0)], website=site, license_today=False, hours=None)
    fx["allclosed"] = api.make_tenant(f"e2e-{RUN}-AllClosed", ["e2e North", "e2e South"], [("Desk A", "queue", 0), ("Desk B", "queue", 1)], website=site, hours=[0, 30])
    fx["nosite"] = api.make_tenant(f"e2e-{RUN}-NoSite", ["e2e Nosite Site"], [("Walk-in Desk", "queue", 0)], hours=[0, 30])
    return fx


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vp", default="phone,desktop", help="comma list of viewports: phone,desktop")
    ap.add_argument("--only", default="A,B,C,D,E,F", help="journeys to run (they build on each other; A is always needed first)")
    ap.add_argument("--api-url"); ap.add_argument("--marketing-url"); ap.add_argument("--admin-url")
    ap.add_argument("--staff-url"); ap.add_argument("--customer-url"); ap.add_argument("--sysadmin-url")
    ap.add_argument("--skip-build", action="store_true", help="reuse the previous build in $E2E_OUT (same ports)")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--screens", action="store_true", help="save a screenshot of every scanned screen to $E2E_OUT/screens")
    ap.add_argument("--timeout", type=int, default=9000, help="per-action timeout (ms)")
    args = ap.parse_args()
    global SAVE_SCREENS
    SAVE_SCREENS = args.screens

    OUT.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(SHOTS, ignore_errors=True)
    shutil.rmtree(OUT / "screens", ignore_errors=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    infra = Infra(args)
    T = Results()
    started = time.time()
    try:
        infra.start()
        api = Api(infra.urls["api"])
        log("run id", RUN, "| today (server)", api.clock_today(), "| local time", time.strftime("%H:%M:%S"))
        journeys = [j for j in args.only.split(",") if j]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed, args=["--no-sandbox"])
            fx = None
            for vp in args.vp.split(","):
                T.vp = vp
                log(f"\n=== viewport: {vp} ===")
                env = Env(vp, browser, infra, T, api, args.timeout)
                if fx is None and any(j in journeys for j in "C"):
                    fx = make_fixture_tenants(env)
                env.fx = fx
                try:
                    for j in journeys:
                        fn = globals().get(f"journey_{j}")
                        if not fn:
                            continue
                        log(f"-- journey {j}")
                        try:
                            fn(env)
                        except Abort as e:
                            T.skip(j, "rest of journey", f"aborted after critical failure: {e}")
                        except Exception as e:  # noqa
                            T.add(j, "journey crashed", False, f"{type(e).__name__}: {e}")
                            traceback.print_exc()
                finally:
                    env.close()
            browser.close()
        server_log_checks(T)
    finally:
        infra.stop()
    report(T, time.time() - started)
    return 1 if any(r["ok"] is False for r in T.rows) else 0


def server_log_checks(T):
    T.vp = "-"
    try:
        txt = (OUT / "api.log").read_text()
    except Exception:
        return
    bad = [l for l in txt.splitlines() if re.search(r"Unhandled promise|Error:|ERROR|TypeError|at .*\.js:\d+", l) and "dns" not in l.lower()]
    T.add("X", "API server log has no errors/stack traces during the run", not bad, " | ".join(bad[:4]))


AREA_NAMES = {"A": "Marketing / sign-up", "B": "Customer-admin", "C": "Patient app", "D": "Staff kiosk", "E": "Cross-app flow", "X": "Server log",
              "adm-L": "F System admin: login", "adm-D": "F System admin: dashboard", "adm-C": "F System admin: customers", "adm-V": "F System admin: customer",
              "adm-P": "F System admin: pricing", "adm-T": "F System admin: clock", "adm-S": "F System admin: session"}


def report(T, secs):
    rows = T.rows
    lines = [f"\n{'=' * 78}\nQBooker e2e report  (run {RUN}, {secs:.0f}s)\n{'=' * 78}"]
    vps = sorted({r["vp"] for r in rows if r["vp"] != "-"}) + (["-"] if any(r["vp"] == "-" for r in rows) else [])
    lines.append(f"{'area':<24}" + "".join(f"{v:>16}" for v in vps) + f"{'total':>16}")
    tot_p = tot_f = 0
    for ar in sorted({r["area"] for r in rows}):
        cells, ap_, af_ = [], 0, 0
        for v in vps:
            rr = [r for r in rows if r["area"] == ar and r["vp"] == v]
            p_ = sum(1 for r in rr if r["ok"] is True); f_ = sum(1 for r in rr if r["ok"] is False); s_ = sum(1 for r in rr if r["ok"] is None)
            ap_ += p_; af_ += f_
            cells.append(f"{p_} pass/{f_} fail" + (f"/{s_} skip" if s_ else ""))
        lines.append(f"{ar + ' ' + AREA_NAMES.get(ar, ''):<24}" + "".join(f"{c:>16}" for c in cells) + f"{ap_} pass/{af_} fail".rjust(16))
        tot_p += ap_; tot_f += af_
    lines.append(f"{'TOTAL':<24}" + " " * 16 * len(vps) + f"{tot_p} pass/{tot_f} fail".rjust(16))
    fails = [r for r in rows if r["ok"] is False]
    if fails:
        lines.append("\nFAILURES")
        for r in fails:
            lines.append(f"  [{r['vp']}/{r['area']}] {r['name']}\n        {r['detail']}" + (f"\n        shot: {r.get('shot')}" if r.get("shot") else ""))
    skips = [r for r in rows if r["ok"] is None]
    if skips:
        lines.append("\nSKIPPED")
        for r in skips:
            lines.append(f"  [{r['vp']}/{r['area']}] {r['name']}: {r['detail']}")
    txt = "\n".join(lines)
    print(txt)
    (OUT / "report.txt").write_text(txt)
    (OUT / "report.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    sys.exit(main())
