#!/usr/bin/env python3
"""Journey F of the QBooker end-to-end suite: the SYSTEM ADMIN console (real browser, real API, no mocks).

Run it through e2e.py:   python3 e2e/e2e.py --only F            (phone 390x844 and desktop 1280x800)

Areas:  L login   D dashboard / reports   C customers (list, search, filter, row actions)   V customer detail
        (account, staff, locations, services, licences)   P pricing & sale   T testing clock   S session   X final sweep

Uses the helpers in e2e.py (Results, Monitor, Actor.scan = overflow / 44px targets / one h1 / labels / alt / focus).
Fixtures are written straight to the throwaway test Postgres (no sign-up, so no DNS/MX dependency); every
tenant is called `e2e-admin-<run id>-...`. The platform price row is saved and restored. The private API
instance has its own simulated clock, so the shared API on :4100 is never touched; run() restores the price row and clears the clock
even if the journey dies half way.
"""
import re, secrets, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import e2e as E  # noqa: E402  (shared helpers; importing it runs nothing)

ROOT, OUT, SHOTS = E.ROOT, E.OUT, E.SHOTS
RUN = E.RUN
log = E.log
V, wait_text, has_text, btn = E.V, E.wait_text, E.has_text, E.btn
PSQL = E.PSQL
ADMIN_PASSWORD = "adminpass"
AREA_NAMES = {"adm-L": "Login", "adm-D": "Dashboard / reports", "adm-C": "Customers list", "adm-V": "Customer detail", "adm-P": "Pricing & sale",
              "adm-T": "Testing clock", "adm-S": "Session", "adm-X": "Final sweep"}


def psql(sql):
    r = E.subprocess.run(PSQL.split() + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[:300]} :: {sql[:120]}")
    return r.stdout.strip()


def q(v):
    return "'" + str(v).replace("'", "''") + "'"


# ----------------------------------------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------------------------------------
def mk_tenant(label, status="active", locs=("Main",), svcs=(("Reception", 0),), first="Ada", last="Lovelace"):
    name = f"e2e-admin-{RUN}-{label}"
    email = f"e2e-admin-{RUN}-{re.sub('[^a-z0-9]', '', label.lower())}@example.com"
    tid = psql(f"insert into tenants (business_name,email,location_count,access_code,payment_method,status,first_name,last_name,company_address,signup_country) "
               f"values ({q(name)},{q(email)},{len(locs)},{q(secrets.token_hex(3).upper())},'card',{q(status)},{q(first)},{q(last)},'1 Test St, London, N1 1AA','GB') returning id")
    t = dict(id=tid, name=name, email=email, locs=[], svcs=[])
    for ln in locs:
        lid = psql(f"insert into locations (tenant_id,name,address,staff_access_code) values ('{tid}',{q(ln)},'',{q(secrets.token_hex(5))}) returning id")
        psql(f"insert into location_codes (code,tenant_id,location_id) values ('QB-{secrets.token_hex(3).upper()}','{tid}','{lid}')")
        t["locs"].append(lid)
    for sn, li in svcs:
        t["svcs"].append(psql(f"insert into services (tenant_id,location_id,name,mode,slot_minutes) values ('{tid}','{t['locs'][li]}',{q(sn)},'hybrid',15) returning id"))
    return t


def mk_lic(t, si, price=100, plan="week", label="Week", days=7, status="available", paid=True, method="card"):
    return psql(f"insert into service_licenses (tenant_id,service_id,plan_id,plan_label,plan_days,price,status,payment_method,paid,paid_at) "
                f"values ('{t['id']}','{t['svcs'][si]}',{q(plan)},{q(label)},{days},{price},{q(status)},{q(method)},{'true' if paid else 'false'},{'now()' if paid else 'null'}) returning id")


def mk_staff(t, first, last):
    email = f"e2e-admin-{RUN}-{first.lower()}{secrets.token_hex(2)}@example.com"
    return dict(id=psql(f"insert into staff_members (tenant_id,first_name,last_name,email) values ('{t['id']}',{q(first)},{q(last)},{q(email)}) returning id"), email=email)


def tenant_db(tid, col):
    return psql(f"select {col} from tenants where id='{tid}'")


class AdminActor(E.Actor):
    """Like Actor, but with a scripted answer for confirm()/prompt() dialogs so the tests can see and drive them."""

    def __init__(self, env, kind):
        kw = dict(E.VIEWPORTS[kind])
        self.env, self.kind, self.phone = env, kind, kind == "phone"
        self.ctx = env.browser.new_context(locale="en-GB", timezone_id="Europe/London", **kw)
        self.ctx.set_default_timeout(env.timeout)
        self.page = self.ctx.new_page()
        self.dialogs, self.answer = [], {"confirm": True, "prompt": "DELETE"}
        self.page.on("dialog", self._dialog)
        self.mon = E.Monitor(self.page)

    def _dialog(self, d):
        self.dialogs.append((d.type, d.message))
        if d.type == "prompt":
            a = self.answer["prompt"]
            d.accept(a) if a is not None else d.dismiss()
        elif self.answer["confirm"]:
            d.accept()
        else:
            d.dismiss()


# ----------------------------------------------------------------------------------------------------------
# helpers on the page
# ----------------------------------------------------------------------------------------------------------
def nav(a, label):
    b = a.page.get_by_role("button", name=label, exact=True).filter(visible=True).first
    b.click()


def settle(p, ms=350):
    p.wait_for_timeout(ms)


def open_customer(a, name):
    p = a.page
    nav(a, "Customers")
    p.get_by_label("Search customers").fill(name)
    p.get_by_role("button", name=re.compile(re.escape(name))).filter(visible=True).first.click()
    p.get_by_role("heading", level=1, name=name).wait_for()


def sys_token(api, base):
    return api.ok("POST", "/api/auth/system/login", dict(password=ADMIN_PASSWORD))["token"]


def sign_in(a, env, password=ADMIN_PASSWORD):
    p = a.page
    p.get_by_label("Password").fill(password)
    btn(p, "Sign in").click()


def lic_card(p, label_text):
    return p.locator(".lic-card").filter(has_text=label_text)


# ==========================================================================================================
# The journey
# ==========================================================================================================
def journey(env):
    T, S = env.T, env.S
    api, base = env.api, env.infra.urls["api"]
    vp = env.vp
    tag = f"{vp}"
    a = AdminActor(env, vp)
    env.actors.append(a)
    p = a.page

    # ---------------- fixtures for this viewport
    acme = mk_tenant(f"{tag}-acme", locs=("Head Office", "Clinic Two"), svcs=(("Reception", 0), ("Scans", 1)))
    mk_lic(acme, 0, 100, "week", "Week", 7); mk_lic(acme, 1, 50, "day", "Day", 1, paid=False, method="invoice")
    mk_lic(acme, 0, 25, "day", "Day (spare)", 1)
    st_amy, st_bob = mk_staff(acme, "Amy", "Adams"), mk_staff(acme, "Bob", "Brown")
    pend = mk_tenant(f"{tag}-pending", status="pending", svcs=(("Desk", 0),))
    mk_lic(pend, 0, 200, "month", "Month", 30, paid=False, method="invoice")
    dis = mk_tenant(f"{tag}-disabled", status="disabled")
    victim = mk_tenant(f"{tag}-victim", svcs=(("Desk", 0),)); mk_lic(victim, 0, 40, "day", "Day", 1)
    flip = mk_tenant(f"{tag}-flip")
    S["tok"] = sys_token(api, base)

    # ================= L. LOGIN
    with T.step("adm-L", "login page loads", p, critical=True):
        a.goto(env.urls["sysadmin"])
        p.get_by_role("heading", level=1, name="System Admin").wait_for()
    a.scan("adm-L", "login screen", focus=True)
    with T.step("adm-L", "submitting with a wrong password shows an error and stays on the login screen", p):
        with a.mon.expect(r"401"):
            sign_in(a, env, "definitely-wrong")
            wait_text(p, "Incorrect password.")
        assert p.get_by_label("Password").is_visible()
        assert p.evaluate("localStorage.getItem('qb_sysadmin_token')") is None, "a token was stored after a failed login"
    a.scan("adm-L", "login screen with error", allow=[r"401"])
    with T.step("adm-L", "the error is announced (role=alert) and the field keeps focus-able state", p):
        assert p.locator("[role=alert]").filter(has_text="Incorrect password.").count() == 1
    with T.step("adm-L", "an empty password is refused without leaving the screen", p):
        p.get_by_label("Password").fill("")
        with a.mon.expect(r"401"):
            btn(p, "Sign in").click()
            wait_text(p, "Incorrect password.")
    with T.step("adm-L", "pressing Enter in the password field submits the form (correct password) and opens the dashboard", p, critical=True):
        p.get_by_label("Password").fill(ADMIN_PASSWORD)
        p.get_by_label("Password").press("Enter")
        p.get_by_role("heading", level=1, name="Dashboard").wait_for()
        assert p.evaluate("!!localStorage.getItem('qb_sysadmin_token')")
    with T.step("adm-L", "the login error does not follow the user into the dashboard", p):
        assert not has_text(p, "Incorrect password."), "stale login error shown on the dashboard"

    # ================= D. DASHBOARD / REPORTS
    ov = api.ok("GET", "/api/system/reports/overview", token=S["tok"])
    with T.step("adm-D", "dashboard figures equal the Reports Overview API (revenue, pending, customers, locations)", p):
        wait_text(p, "Locations, all customers")
        stats = p.locator(".stat").all_inner_texts()
        flat = " | ".join(s.replace("\n", " ") for s in stats)
        assert f"£{ov['totalRevenue']:.2f}" in flat, flat
        assert f"£{ov['pendingRevenue']:.2f}" in flat, flat
        assert re.search(rf"\b{ov['customerCount']}\b", flat) and re.search(rf"\b{ov['totalLocations']}\b", flat), flat
    with T.step("adm-D", "revenue chart is exposed to assistive tech with its figures", p):
        lab = p.locator("[role=img]").first.get_attribute("aria-label") or ""
        assert lab.startswith("Revenue by plan"), lab
    with T.step("adm-D", "unpaid-licence alert strip: 'Review' jumps to the Customers list filtered to Unpaid", p):
        wait_text(p, "unpaid licences")
        btn(p, "Review").click()
        p.get_by_role("heading", level=1, name="Customers").wait_for()
        assert p.get_by_role("button", name=re.compile(r"^Unpaid \d+")).get_attribute("aria-pressed") == "true"
        assert has_text(p, acme["name"]) or p.get_by_role("button", name=re.compile(re.escape(acme["name"]))).count() > 0
    nav(a, "Dashboard")
    p.get_by_role("heading", level=1, name="Dashboard").wait_for()
    a.scan("adm-D", "dashboard", focus=True)

    # ================= C. CUSTOMERS LIST
    with T.step("adm-C", "customers list opens with every fixture and status counts that match the API", p, critical=True):
        nav(a, "Customers")
        p.get_by_role("heading", level=1, name="Customers").wait_for()
        p.get_by_role("button", name=re.compile(r"^All \d+")).click()   # the Unpaid filter from 'Review' is still on
        p.get_by_label("Search customers").fill(f"e2e-admin-{RUN}-{tag}")
        for t in (acme, pend, dis, victim, flip):
            p.get_by_role("button", name=re.compile(re.escape(t["name"]))).filter(visible=True).first.wait_for()
        tenants = api.ok("GET", "/api/system/tenants", token=S["tok"])["tenants"]
        chip = lambda n: p.get_by_role("button", name=re.compile(rf"^{n} \d+")).inner_text()
        assert chip("All") == f"All {len(tenants)}", chip("All")
        assert chip("Pending") == f"Pending {sum(1 for t in tenants if t['status'] == 'pending')}", chip("Pending")
        assert chip("Disabled") == f"Disabled {sum(1 for t in tenants if t['status'] == 'disabled')}", chip("Disabled")
        assert chip("Enabled") == f"Enabled {sum(1 for t in tenants if t['status'] != 'disabled')}", chip("Enabled")
        assert chip("Unpaid") == f"Unpaid {sum(1 for t in tenants if int(t['unpaid_count']) > 0)}", chip("Unpaid")
    a.scan("adm-C", "customers list", focus=True)
    with T.step("adm-C", "search narrows by business name and by email; no match shows an empty state", p):
        s = p.get_by_label("Search customers")
        s.fill(acme["name"])
        assert p.get_by_role("button", name=re.compile(re.escape(pend["name"]))).filter(visible=True).count() == 0
        s.fill(pend["email"].upper())
        p.get_by_role("button", name=re.compile(re.escape(pend["name"]))).filter(visible=True).first.wait_for()
        s.fill("zzz-no-such-customer-zzz")
        wait_text(p, "No customers match your search.")
        s.fill(f"e2e-admin-{RUN}-{tag}")
    with T.step("adm-C", "status filters: Pending / Disabled / Enabled / Unpaid show exactly the right fixtures", p):
        vis = lambda t: p.get_by_role("button", name=re.compile(re.escape(t["name"]))).filter(visible=True).count() > 0
        p.get_by_role("button", name=re.compile(r"^Pending \d+")).click()
        assert vis(pend) and not vis(acme) and not vis(dis)
        p.get_by_role("button", name=re.compile(r"^Disabled \d+")).click()
        assert vis(dis) and not vis(pend) and not vis(acme)
        p.get_by_role("button", name=re.compile(r"^Enabled \d+")).click()
        assert vis(acme) and vis(pend) and not vis(dis)
        p.get_by_role("button", name=re.compile(r"^Unpaid \d+")).click()
        assert vis(acme) and vis(pend) and not vis(victim) and not vis(dis)
        p.get_by_role("button", name=re.compile(r"^All \d+")).click()
        assert vis(victim) and vis(dis)
    with T.step("adm-C", "list row shows spend, services, status and the unpaid badge", p):
        txt = p.locator(".cust-card:visible, tbody tr:visible").filter(has_text=acme["name"]).first.inner_text()
        assert "£175.00" in txt and "1 unpaid" in txt and "active" in txt, txt
    with T.step("adm-C", "row actions: Disable (confirm) -> row turns disabled; Enable -> active again; cancelling the confirm changes nothing", p):
        s = p.get_by_label("Search customers"); s.fill(flip["name"])
        def row_action(label):
            if a.phone:
                p.get_by_role("button", name=f"More actions for {flip['name']}").click()
                p.get_by_role("menuitem", name=label).click()
            else:
                p.locator("tbody tr").filter(has_text=flip["name"]).get_by_role("button", name=label, exact=True).click()
        a.answer["confirm"] = False
        row_action("Disable"); settle(p)
        assert tenant_db(flip["id"], "status") == "active", "dismissed confirm still disabled the account"
        a.answer["confirm"] = True
        row_action("Disable")
        p.locator(".cust-card:visible, tbody tr:visible").filter(has_text=flip["name"]).get_by_text("disabled", exact=True).first.wait_for()
        assert tenant_db(flip["id"], "status") == "disabled"
        assert any("Disable" in m for k, m in a.dialogs), a.dialogs
        row_action("Enable")
        p.locator(".cust-card:visible, tbody tr:visible").filter(has_text=flip["name"]).get_by_text("active", exact=True).first.wait_for()
        assert tenant_db(flip["id"], "status") == "active"
    with T.step("adm-C", "a failed row action (account deleted behind the console's back) shows an error banner, not a silent failure", p):
        ghost = mk_tenant(f"{tag}-ghost")
        nav(a, "Dashboard"); nav(a, "Customers")      # switching tabs re-reads the list, so a customer created meanwhile shows up
        s = p.get_by_label("Search customers"); s.fill(ghost["name"]); p.get_by_role("button", name=re.compile(re.escape(ghost["name"]))).filter(visible=True).first.wait_for()
        psql(f"delete from tenants where id='{ghost['id']}'")
        a.answer["confirm"] = True
        with a.mon.expect(r"404", r"not found", r"Unhandled", r"Customer"):
            if a.phone:
                p.get_by_role("button", name=f"More actions for {ghost['name']}").click(); p.get_by_role("menuitem", name="Disable").click()
            else:
                p.locator("tbody tr").filter(has_text=ghost["name"]).get_by_role("button", name="Disable", exact=True).click()
            wait_text(p, "Customer not found.")
    s.fill("")
    a.scan("adm-C", "customers list after actions", allow=[r"404"])

    # ================= V. CUSTOMER DETAIL
    with T.step("adm-V", "opening a customer shows its detail page with one h1 (the business name) and a back button", p, critical=True):
        open_customer(a, acme["name"])
        wait_text(p, "Staff users (2)")
        assert p.get_by_role("button", name="Back to all customers").is_visible()
    a.scan("adm-V", "customer detail", focus=True)
    with T.step("adm-V", "account fields show the stored values", p):
        assert p.get_by_label("First name").first.input_value() == "Ada"
        assert p.get_by_label("Business name").input_value() == acme["name"]
        assert p.get_by_label("Email").first.input_value() == acme["email"]
    with T.step("adm-V", "editing the first name and leaving the field saves it", p):
        f = p.get_by_label("First name").first
        f.fill("Grace"); f.blur(); settle(p, 600)
        assert tenant_db(acme["id"], "first_name") == "Grace"
    with T.step("adm-V", "editing the address lines saves a combined address", p):
        l1 = p.get_by_label("Address line 1"); l1.fill("22 New Road"); l1.blur(); settle(p, 600)
        assert tenant_db(acme["id"], "company_address").startswith("22 New Road"), tenant_db(acme["id"], "company_address")
    with T.step("adm-V", "an invalid edit (blank business name) shows an error banner and does not crash the page", p):
        bn = p.get_by_label("Business name")
        with a.mon.expect(r"400", r"can't be blank", r"Unhandled"):
            bn.fill(""); bn.blur()
            wait_text(p, "can't be blank")
        assert tenant_db(acme["id"], "business_name") == acme["name"], "blank name saved"
        btn(p, "Dismiss").click()
        assert not has_text(p, "can't be blank")
    with T.step("adm-V", "an invalid email edit shows the server's message", p):
        em = p.get_by_label("Email").first
        with a.mon.expect(r"400", r"valid email", r"Unhandled"):
            em.fill("not-an-email"); em.blur()
            wait_text(p, "Enter a valid email address.")
        assert tenant_db(acme["id"], "email") == acme["email"]
        btn(p, "Dismiss").click()
    with T.step("adm-V", "the 'Location count (billing)' field rejects nonsense with a message, and accepts a valid change", p):
        lc = p.get_by_label("Location count (billing)")
        with a.mon.expect(r"400", r"whole number", r"Unhandled"):
            lc.fill("-3"); lc.blur()
            wait_text(p, "whole number")
        btn(p, "Dismiss").click()
        lc.fill("2"); lc.blur(); settle(p, 400)
        assert tenant_db(acme["id"], "location_count") == "2"
    # staff
    with T.step("adm-V", "staff: edit a member (validation message for a duplicate email, then a real change)", p):
        p.get_by_role("button", name="Edit Amy Adams").click()
        p.get_by_label("Email").last.fill(st_bob["email"])
        with a.mon.expect(r"409", r"already registered"):
            btn(p, "Save", exact=True).click()
            wait_text(p, "already registered to a staff member")
        btn(p, "Dismiss").click()
        p.get_by_label("First name").last.fill("Amelia")
        p.get_by_label("Email").last.fill(f"e2e-admin-{RUN}-amelia-{vp}@example.com")
        btn(p, "Save", exact=True).click()
        p.get_by_text("Amelia Adams").first.wait_for()
        assert psql(f"select first_name from staff_members where id='{st_amy['id']}'") == "Amelia"
    with T.step("adm-V", "staff: Save is disabled while a field is empty", p):
        p.get_by_role("button", name="Edit Bob Brown").click()
        p.get_by_label("Last name").last.fill("")
        assert btn(p, "Save", exact=True).is_disabled()
        btn(p, "Cancel").click()
    with T.step("adm-V", "staff: Delete asks for confirmation (cancel keeps, confirm removes)", p):
        a.answer["confirm"] = False
        p.get_by_role("button", name="Delete Bob Brown").click(); settle(p)
        assert psql(f"select count(*) from staff_members where id='{st_bob['id']}'") == "1"
        a.answer["confirm"] = True
        p.get_by_role("button", name="Delete Bob Brown").click()
        wait_text(p, "Staff users (1)")
        assert psql(f"select count(*) from staff_members where id='{st_bob['id']}'") == "0"
    # locations & services
    with T.step("adm-V", "location: rename saves; clearing the name shows an error and leaves it unchanged", p):
        nm = p.get_by_label("Location name").first
        nm.fill("HQ Renamed"); nm.blur(); settle(p, 600)
        assert psql(f"select name from locations where id='{acme['locs'][0]}'") == "HQ Renamed"
        with a.mon.expect(r"400", r"can't be blank", r"Unhandled"):
            nm = p.get_by_label("Location name").first
            nm.fill(""); nm.blur()
            wait_text(p, "can't be blank")
        assert psql(f"select name from locations where id='{acme['locs'][0]}'") == "HQ Renamed"
        btn(p, "Dismiss").click()
    svc1 = lambda: p.locator(".svc-block").filter(has_text="Reception")
    with T.step("adm-V", "service: change type (never-live service) and slot length", p):
        svc1().get_by_label("Type").select_option("queue"); settle(p, 500)
        assert psql(f"select mode from services where id='{acme['svcs'][0]}'") == "queue"
        svc1().get_by_label("Type").select_option("appointment")
        svc1().get_by_label("Slot length").select_option("30"); settle(p, 500)
        assert psql(f"select slot_minutes from services where id='{acme['svcs'][0]}'") == "30"
    with T.step("adm-V", "service: Archive / Unarchive toggles the badge", p):
        svc1().get_by_role("button", name="Archive", exact=True).click()
        svc1().get_by_text("Archived", exact=True).wait_for()
        assert psql(f"select archived from services where id='{acme['svcs'][0]}'") == "t"
        svc1().get_by_role("button", name="Unarchive", exact=True).click()
        svc1().get_by_role("button", name="Archive", exact=True).wait_for()
    a.scan("adm-V", "customer detail with licences", focus=False)
    # licences
    with T.step("adm-V", "free licence: grant a Month plan -> a £0 'free — granted' available licence appears", p):
        svc1().get_by_role("button", name="+ Free license").click()
        svc1().get_by_label("Plan").select_option("month")
        btn(p, "Grant").click()
        lic_card(p, "Month (free — granted)").first.wait_for()
        assert "Free" in lic_card(p, "Month (free — granted)").first.inner_text()
        assert psql(f"select count(*) from service_licenses where service_id='{acme['svcs'][0]}' and plan_label like 'Month (free%' and price=0") == "1"
    with T.step("adm-V", "free licence: custom plan with a number of days", p):
        svc1().get_by_role("button", name="+ Free license").click()
        svc1().get_by_label("Plan").select_option("custom")
        svc1().get_by_label("Days").fill("12")
        btn(p, "Grant").click()
        lic_card(p, "12-day custom plan (free — granted)").first.wait_for()
    with T.step("adm-V", "annual licence: Add is disabled until a price is entered; adds an unpaid invoice licence at the agreed price", p):
        svc1().get_by_role("button", name="+ Annual license").click()
        assert btn(p, "Add", exact=True).is_disabled()
        svc1().get_by_label("Agreed price £ (ex VAT)").fill("900")
        btn(p, "Add", exact=True).click()
        c = lic_card(p, "Year (agreed price)").first
        c.wait_for()
        txt = c.inner_text()
        assert "Invoice — unpaid" in txt and "£900" in txt, txt
    with T.step("adm-V", "annual licence: a price with fractions of a penny shows the server's validation message", p):
        svc1().get_by_role("button", name="+ Annual license").click()
        svc1().get_by_label("Agreed price £ (ex VAT)").fill("100.005")
        with a.mon.expect(r"400", r"Enter the agreed|decimal"):
            btn(p, "Add", exact=True).click()
            p.locator("[role=alert]").filter(has_text=re.compile(r"decimal|agreed", re.I)).first.wait_for()
        btn(p, "Dismiss").click()
        btn(p, "Cancel").click()
    with T.step("adm-V", "mark paid: the 'Invoice — unpaid' licence becomes 'Invoice — paid' and the button disappears", p):
        mb = p.get_by_role("button", name=re.compile(r"Mark Year \(agreed price\) license on Reception as paid"))
        mb.click()
        lic_card(p, "Year (agreed price)").first.get_by_text("Invoice — paid").wait_for()
        assert mb.count() == 0
        assert psql(f"select paid from service_licenses where service_id='{acme['svcs'][0]}' and plan_id='year'") == "t"
    with T.step("adm-V", "refund: confirm text names the licence; cancel keeps it, confirm marks it Refunded and the buttons go", p):
        a.answer["confirm"] = False
        rb = p.get_by_role("button", name=re.compile(r"Refund Day \(spare\) license on Reception"))
        rb.click(); settle(p)
        assert psql(f"select status from service_licenses where service_id='{acme['svcs'][0]}' and plan_label='Day (spare)'") == "available"
        a.answer["confirm"] = True
        rb.click()
        lic_card(p, "Day (spare)").first.get_by_text("Refunded", exact=True).wait_for()
        assert rb.count() == 0
        assert psql(f"select status from service_licenses where service_id='{acme['svcs'][0]}' and plan_label='Day (spare)'") == "refunded"
    with T.step("adm-V", "a licence that went live behind the console's back: Refund shows the server's reason", p):
        gl = mk_lic(acme, 0, 10, "day", "Day (live)", 1)
        p.reload(); p.get_by_role("button", name="Customers", exact=True).filter(visible=True).first.wait_for()
        open_customer(a, acme["name"])
        rb = p.get_by_role("button", name=re.compile(r"Refund Day \(live\) license on Reception"))
        rb.wait_for()
        psql(f"update service_licenses set status='expired', start_date=current_date-10, end_date=current_date-9 where id='{gl}'")
        with a.mon.expect(r"409", r"Only a license"):
            rb.click()
            wait_text(p, "can be refunded")
        btn(p, "Dismiss").click()
    with T.step("adm-V", "service delete: confirm removes the service and its licences; nothing else is touched", p):
        a.answer["confirm"] = True
        p.locator(".svc-block").filter(has_text="Scans").get_by_role("button", name="Delete", exact=True).click()
        p.locator(".svc-block").filter(has_text="Scans").wait_for(state="detached")
        assert psql(f"select count(*) from services where tenant_id='{acme['id']}'") == "1"
    with T.step("adm-V", "location delete: confirm removes the location; the count shrinks and the page stays healthy", p):
        clinic = p.locator('section[aria-label="Location Clinic Two"]')   # the name is an input value, not text
        clinic.get_by_role("button", name="Delete location").click()
        clinic.wait_for(state="detached")
        assert psql(f"select count(*) from locations where tenant_id='{acme['id']}'") == "1"
        wait_text(p, "1 location")
    # status changes
    with T.step("adm-V", "Disable account (confirm) -> badge 'Disabled', the tenant is really locked out; Enable account restores it", p):
        a.answer["confirm"] = True
        btn(p, "Disable account").click()
        p.locator(".badge").filter(has_text="Disabled").first.wait_for()
        assert tenant_db(acme["id"], "status") == "disabled"
        assert api.req("GET", f"/api/public/tenant/{acme['id']}/info")[0] == 404, "patients can still reach a disabled business"
        btn(p, "Enable account").click()
        p.locator(".badge").filter(has_text="Active").first.wait_for()
        assert tenant_db(acme["id"], "status") == "active"
        assert api.req("GET", f"/api/public/tenant/{acme['id']}/info")[0] == 200
    with T.step("adm-V", "pending customer: 'Activate account' is hidden while a licence is unpaid; marking it paid activates the account", p):
        nav(a, "Customers")
        open_customer(a, pend["name"])
        wait_text(p, "Payment pending")
        assert p.get_by_role("button", name="Activate account").count() == 0
        p.get_by_role("button", name=re.compile(r"Mark Month license on Desk as paid")).click()
        p.locator(".badge").filter(has_text="Active").first.wait_for()
        assert tenant_db(pend["id"], "status") == "active"
        assert any("account activated" in m for m in psql(f"select message from audit_log where tenant_id='{pend['id']}'").split("\n"))
    with T.step("adm-V", "pending customer with nothing unpaid: 'Activate account' button activates it", p):
        psql(f"update tenants set status='pending' where id='{pend['id']}'")
        p.reload(); nav(a, "Customers"); open_customer(a, pend["name"])
        p.get_by_role("button", name="Activate account").click()
        p.locator(".badge").filter(has_text="Active").first.wait_for()
        assert tenant_db(pend["id"], "status") == "active"
    with T.step("adm-V", "disabled customer opens read-only-safe: shows 'Enable account' and the Disabled badge", p):
        nav(a, "Customers"); open_customer(a, dis["name"])
        p.locator(".badge").filter(has_text="Disabled").first.wait_for()
        assert p.get_by_role("button", name="Enable account").is_visible()
    with T.step("adm-V", "a customer deleted elsewhere: detail shows an error, not an endless 'Loading…'", p):
        gone = mk_tenant(f"{tag}-gone")
        nav(a, "Customers"); p.get_by_label("Search customers").fill(gone["name"])
        row = p.get_by_role("button", name=re.compile(re.escape(gone["name"]))).filter(visible=True).first
        row.wait_for(); psql(f"delete from tenants where id='{gone['id']}'")
        with a.mon.expect(r"404", r"not found"):
            row.click()
            wait_text(p, "Customer not found.")
        assert not has_text(p, "Loading…"), "stuck on Loading… after the load failed"
        nav(a, "Customers")
    # delete customer
    with T.step("adm-V", "Delete customer: a wrong confirmation word or cancelling keeps the customer; typing DELETE removes it", p):
        open_customer(a, victim["name"])
        a.answer["prompt"] = "delete"          # wrong case
        btn(p, "Delete customer").click(); settle(p)
        assert tenant_db(victim["id"], "status") == "active"
        a.answer["prompt"] = None              # cancel
        btn(p, "Delete customer").click(); settle(p)
        assert psql(f"select count(*) from tenants where id='{victim['id']}'") == "1"
        a.answer["prompt"] = "DELETE"
        btn(p, "Delete customer").click()
        p.get_by_role("heading", level=1, name="Customers").wait_for()
        assert psql(f"select count(*) from tenants where id='{victim['id']}'") == "0"
        snap = psql(f"select total_revenue from deleted_tenant_revenue where original_tenant_id='{victim['id']}'")
        assert snap and float(snap) == 40.0, f"revenue snapshot {snap!r}"
        assert any(k == "prompt" and "permanently deletes" in m for k, m in a.dialogs)
    with T.step("adm-V", "the deleted customer is gone from the list and the dashboard notes the retained revenue", p):
        p.get_by_label("Search customers").fill(victim["name"])
        wait_text(p, "No customers match your search.")
        nav(a, "Dashboard")
        wait_text(p, "deleted customer")

    # ================= P. PRICING
    saved = psql("select coalesce((select value::text from platform_settings where key='plan_prices'),'')")
    S["saved_pricing"] = saved
    with T.step("adm-P", "pricing tab shows the prices customers are charged (matches the public API)", p, critical=True):
        nav(a, "Pricing")
        p.get_by_role("heading", level=1, name="Pricing").wait_for()
        pub = api.ok("GET", "/api/public/pricing")["pricing"]
        assert p.get_by_label("Week (per location)").input_value() == str(pub["week"]), (p.get_by_label("Week (per location)").input_value(), pub)
    a.scan("adm-P", "pricing", focus=True)
    with T.step("adm-P", "editing a price and saving updates the public price list and confirms the save", p):
        w = p.get_by_label("Week (per location)")
        w.fill("123.5")
        btn(p, "Save pricing").click()
        wait_text(p, "Saved")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["week"] == 123.5
    with T.step("adm-P", "after a reload the saved price is what the form shows", p):
        p.reload(); nav(a, "Pricing")
        assert p.get_by_label("Week (per location)").input_value() == "123.5"
    with T.step("adm-P", "an invalid price (negative) is refused with the server's message and nothing is saved", p):
        w = p.get_by_label("Week (per location)")
        w.fill("-5")
        with a.mon.expect(r"400", r"between 0", r"Unhandled"):
            btn(p, "Save pricing").click()
            wait_text(p, "between 0 and 1,000,000")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["week"] == 123.5
        btn(p, "Dismiss").click()
    with T.step("adm-P", "a price with more than two decimals is refused; a cleared field is not silently saved as 0", p):
        w = p.get_by_label("Week (per location)")
        w.fill("19.999")
        with a.mon.expect(r"400", r"decimal"):
            btn(p, "Save pricing").click()
            wait_text(p, "at most 2 decimal places")
        btn(p, "Dismiss").click()
        w.fill("")
        btn(p, "Save pricing").click()
        wait_text(p, "Enter a price for Week")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["week"] == 123.5, "an empty price box was saved as 0"
        btn(p, "Dismiss").click()
        p.reload(); nav(a, "Pricing")
    with T.step("adm-P", "sale: switch on, set a sale price for Week, save -> public pricing shows the sale and what's charged is the sale price", p):
        cb = p.get_by_label("Sale active")
        cb.check()
        p.get_by_label("Week sale price").fill("99")
        btn(p, "Save sale").click()
        wait_text(p, "Saved")
        sale = api.ok("GET", "/api/public/pricing")["pricing"]["sale"]
        assert sale["active"] is True and sale["week"] == 99 and sale.get("day") in (None,), sale
    with T.step("adm-P", "sale: a sale price above the regular price is refused", p):
        p.get_by_label("Week sale price").fill("500")
        with a.mon.expect(r"400", r"higher than"):
            btn(p, "Save sale").click()
            wait_text(p, "can't be higher than its regular price")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["sale"]["week"] == 99
        btn(p, "Dismiss").click()
        p.get_by_label("Week sale price").fill("99")
    with T.step("adm-P", "sale: switching it off keeps list prices and saves", p):
        p.get_by_label("Sale active").uncheck()
        btn(p, "Save sale").click(); wait_text(p, "Saved")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["sale"]["active"] is False
        # clearing a sale price field means "no discount for this plan"
        p.get_by_label("Week sale price").fill("")
        btn(p, "Save sale").click(); wait_text(p, "Saved")
        assert api.ok("GET", "/api/public/pricing")["pricing"]["sale"].get("week") in (None,)
    a.scan("adm-P", "pricing after save", focus=False)

    # ================= T. TESTING CLOCK
    with T.step("adm-T", "testing tab shows today's date as a real (not simulated) date", p, critical=True):
        nav(a, "Testing")
        p.get_by_role("heading", level=1, name="Testing").wait_for()
        wait_text(p, "real date")
        real = api.ok("GET", "/api/public/clock")["today"]
        wait_text(p, real)
    a.scan("adm-T", "testing clock", focus=True)
    with T.step("adm-T", "setting a simulated date changes the server clock for everyone and shows 'simulated' + a reset button", p):
        p.get_by_label("Simulated date").fill("2031-05-05")
        btn(p, "Set date").click()
        wait_text(p, "simulated", exact=True)
        assert api.ok("GET", "/api/public/clock") == dict(today="2031-05-05", simulated=True)
        btn(p, "Reset to real date").wait_for(state="visible")
    a.scan("adm-T", "testing clock simulated", focus=False)
    with T.step("adm-T", "an empty date is refused with a message and the clock stays simulated", p):
        p.get_by_label("Simulated date").fill("")
        with a.mon.expect(r"400", r"date required", r"YYYY"):
            btn(p, "Set date").click()
            p.locator("[role=alert]").first.wait_for()
        assert api.ok("GET", "/api/public/clock")["today"] == "2031-05-05"
        btn(p, "Dismiss").click()
    with T.step("adm-T", "the simulated date reaches the rest of the console: licence statuses are resolved against it", p):
        nav(a, "Customers"); open_customer(a, acme["name"])
        # the week licence has no dates; just check the page still loads under a far-future clock
        wait_text(p, "Staff users")
        nav(a, "Testing")
    with T.step("adm-T", "while simulated, the marketing site (another app) shows the 'Simulated date' badge; after the reset it is gone", p):
        mk = a.ctx.new_page()
        try:
            def open_marketing():
                mk.goto(env.urls["marketing"])
                if a.phone:   # the landing nav hides its badge on phones; the sign-up screen shows a 'Simulated date' banner instead
                    mk.get_by_role("button", name=re.compile("Start free trial")).filter(visible=True).first.click()
                mk.get_by_role("heading", level=1).filter(visible=True).first.wait_for()
            open_marketing()
            wait_text(mk, "Simulated date: 2031-05-05")
            api.ok("DELETE", "/api/system/clock", token=S["tok"])
            open_marketing()
            mk.wait_for_timeout(500)
            assert not has_text(mk, "Simulated date"), "badge still shown after the clock was cleared"
            api.ok("POST", "/api/system/clock", dict(date="2031-05-05"), token=S["tok"])   # back to simulated for the next step
            p.reload(); nav(a, "Testing")
        finally:
            mk.close()
    with T.step("adm-T", "Reset to real date restores the true date and hides the button", p):
        btn(p, "Reset to real date").click()
        wait_text(p, "real date", exact=True)
        assert api.ok("GET", "/api/public/clock")["simulated"] is False
        assert btn(p, "Reset to real date").count() == 0

    # ================= S. SESSION
    with T.step("adm-S", "Sign out returns to the login screen, clears the stored token and the dashboard cannot be reached by reload", p):
        # sign-out control: header button on phone, sidebar on desktop
        p.get_by_role("button", name="Sign out").filter(visible=True).first.click()
        p.get_by_role("heading", level=1, name="System Admin").wait_for()
        assert p.evaluate("localStorage.getItem('qb_sysadmin_token')") is None
        p.reload()
        p.get_by_role("heading", level=1, name="System Admin").wait_for()
    with T.step("adm-S", "an expired / invalid stored token sends the user back to the login screen (not a half-loaded dashboard)", p):
        p.evaluate("localStorage.setItem('qb_sysadmin_token','not-a-real-token')")
        with a.mon.expect(r"401"):
            p.reload()
            p.get_by_role("heading", level=1, name="System Admin").wait_for(timeout=4000)
        assert p.evaluate("localStorage.getItem('qb_sysadmin_token')") is None
    with T.step("adm-S", "a tenant-admin token pasted into storage is also refused (403) and ends the session", p):
        tok = tenant_token(api, acme)
        p.evaluate("(t) => localStorage.setItem('qb_sysadmin_token', t)", tok)
        with a.mon.expect(r"403"):
            p.reload()
            p.get_by_role("heading", level=1, name="System Admin").wait_for(timeout=4000)
    with T.step("adm-S", "signing back in after all that works (login still healthy)", p):
        sign_in(a, env)
        p.get_by_role("heading", level=1, name="Dashboard").wait_for()
    a.scan("adm-S", "dashboard after re-login", allow=[r"401", r"403"])
    with T.step("adm-S", "keyboard: Tab order reaches the main navigation and an active nav item exposes aria-current", p):
        cur = p.locator("[aria-current=page]").filter(visible=True).count()
        assert cur >= 1
    # restore global price row for the other suites
    if saved:
        psql(f"insert into platform_settings (key,value) values ('plan_prices',{q(saved)}::jsonb) on conflict (key) do update set value=excluded.value")
    else:
        psql("delete from platform_settings where key='plan_prices'")


def tenant_token(api, t):
    r = api.ok("POST", "/api/auth/admin/request-otp", dict(email=t["email"]))
    return api.ok("POST", "/api/auth/admin/verify-otp", dict(email=t["email"], code=r["demoOtp"]))["token"]


def run(env):
    """Journey F. The platform price row and the simulated clock are global state: whatever happens, put them back."""
    api = env.api
    saved = psql("select coalesce((select value::text from platform_settings where key='plan_prices'),'')")
    try:
        journey(env)
    finally:
        if saved:
            psql(f"insert into platform_settings (key,value) values ('plan_prices',{q(saved)}::jsonb) on conflict (key) do update set value=excluded.value")
        else:
            psql("delete from platform_settings where key='plan_prices'")
        try:
            tok = sys_token(api, env.infra.urls["api"])
            api.req("DELETE", "/api/system/clock", token=tok)
        except Exception as e:  # noqa
            log("could not clear the simulated clock:", e)
