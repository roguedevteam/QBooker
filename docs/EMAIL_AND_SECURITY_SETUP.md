# Switching on real sign-in emails (and the security settings that go with it)

For: the founder. No coding needed. Everything below is done in a web browser (and, for the secret keys,
one optional PowerShell line). Allow about 45 minutes the first time, most of it waiting for DNS.

## What this is, in plain words

QBooker has no passwords. People sign in by typing a 6-digit code that we email them. Until now the
code was shown on the screen as a "demo" so we could test. That is fine for testing and **not acceptable
for real customers**: anyone who knew a business owner's email address could sign in as them.

After this setup:

* the code is **only** sent by email. It is never shown on screen and never returned by the server;
* the code is stored scrambled (a "hash"), so even someone who read our database could not use it;
* the sign-in page gives the **same answer** whether or not an account exists, so nobody can use it to find out
  who our customers are;
* sign-in sessions are shorter (12 hours for owners, 16 hours for staff kiosks) but a session that is in use
  renews itself, so a kiosk never logs out in the middle of a shift;
* if email is not set up, the server **refuses to send or show codes** (it shows "isn't switched on yet") instead of
  quietly falling back to the old demo behaviour.

You will use three things: **Resend** (sends the emails), **your domain's DNS settings** (proves the
emails really come from you), and **Railway** (where the QBooker server runs and where its settings live).

---

## Part 1 - Create the Resend account (5 minutes)

1. Go to **https://resend.com** and choose **Sign up**. Use your company email.
2. Confirm your email address when Resend asks.
3. The free plan is enough to start (a few thousand emails a month at the time of writing; check Resend's
   pricing page for today's limits).

## Part 2 - Prove the sending domain is yours (15 minutes, then wait)

Emails sent "from" a domain you have not proved are junk-foldered or rejected. You only do this once.

**Pick the address you want codes to come from.** We recommend a sub-domain used only for this, for example
`mail.yourdomain.com`, and the sender name `QBooker <login@mail.yourdomain.com>`. (Using a sub-domain keeps your
normal company email completely separate and safe.)

1. In Resend, open **Domains** and choose **Add Domain**. Type the sub-domain (`mail.yourdomain.com`).
   Pick the region closest to most of your customers (it only affects where the sending happens).
2. Resend now shows a short table of **DNS records** (usually 3 to 4 rows: types **TXT**, **MX**, and sometimes **CNAME**).
   Keep this page open.
3. In another browser tab, sign in to wherever your domain's DNS is managed. That is the company you bought the
   domain from (GoDaddy, Namecheap, IONOS, Fasthosts, Cloudflare, Wix...). Look for **DNS**, **DNS records** or
   **Manage DNS**.
4. Add each row from Resend exactly as shown: the **Type**, the **Name/Host**, and the **Value**. Tips:
   * Some providers add your domain to the end of the Name automatically; if so, type only the part before it.
   * Copy and paste values; do not retype them. Do not add quotation marks unless the provider asks.
   * If you already have an MX record for the *main* domain, leave it alone. The Resend records are for the
     sub-domain only.
5. Back in Resend, press **Verify DNS Records**. It can take a few minutes, sometimes a few hours. When every row
   shows **Verified**, you are done with this part.
6. Recommended, one more record (Resend's domain page explains it): a **DMARC** TXT record, so receiving mail systems
   trust you. A simple starting value is `v=DMARC1; p=none;` on the name `_dmarc.mail` (your provider may want
   `_dmarc.mail.yourdomain.com`). It is optional for the first test and good practice before you go live.

## Part 3 - Create the API key (2 minutes)

1. In Resend, open **API Keys** and choose **Create API Key**.
2. Name it `qbooker-production`. Permission: **Sending access**. Domain: choose the one you just verified.
3. Copy the key now (it starts with `re_`). **Resend only shows it once.** Paste it into your password manager.
   Treat it like a bank password: never email it or put it in a chat or a document.

## Part 4 - Make two secret values (3 minutes)

The server needs two long random values (like very long passwords) to scramble things safely. You never type
these in again.

Easiest way, in **Windows PowerShell** (press Start, type `PowerShell`, press Enter). Paste this line and press Enter:

    $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''

It prints 64 letters and numbers. Copy them. Run the same line again to get a second, different value.
(Alternative with no terminal: ask your password manager to generate a 64-character password.)

* First value -> `JWT_SECRET` (if you already have one set on Railway that is long and random, **keep it**: changing
  it signs everyone out).
* Second value -> `OTP_PEPPER`.

## Part 5 - Put the settings into Railway (10 minutes)

1. Open **https://railway.app**, open the QBooker project, click the **server (API)** service, then **Variables**.
2. Add (or edit) each of these. Use **New Variable** and paste name and value. Names are case-sensitive.

| Name | Value to enter |
|---|---|
| `NODE_ENV` | `production` |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | the key from Part 3 (starts `re_`) |
| `EMAIL_FROM` | `QBooker <login@mail.yourdomain.com>` (the verified sub-domain from Part 2) |
| `EMAIL_REPLY_TO` | an inbox people can write to, e.g. `support@yourdomain.com` |
| `APP_NAME` | `QBooker` (shown in the email subject and header) |
| `JWT_SECRET` | the first secret value |
| `OTP_PEPPER` | the second secret value |
| `TRUST_PROXY` | `1` (Railway puts one gateway in front of the server; this lets the server see each visitor's real address for rate limits) |
| `CORS_ORIGIN` | the web addresses of your apps, comma-separated (already set if the apps work today) |

3. **Do not set `DEMO_MODE`** (leave it absent). If it is `true`, the server hands out sign-in codes on screen again.
4. Railway redeploys automatically. Wait until the deployment shows as **Active**.
5. Open the service's **Deploy Logs**. You should **not** see a banner saying `EMAIL IS NOT SET UP`.
   If you do, the text next to it says which variable is missing.

> Database update: this release adds a small database change (`server/db/migrations/0018_...sql`). Run the migrate
> step as you did for earlier migrations. It also clears any old sign-in codes, so anyone mid-sign-in just asks for a new one.

## Part 6 - Check that it works (10 minutes)

Tick every line.

- [ ] Open `https://<your-api-address>/health`. It shows `{"ok":true}`.
- [ ] Open the **sign-up** page and create a test account using an email address you can read (not a work alias that forwards).
- [ ] After you enter your details, the page says "Check your email" and **shows no code**.
- [ ] The email arrives within a minute, from your sender name, with the code. If it is in **spam**, mark it "not spam" and
      re-check Part 2 (all records verified, DMARC added).
- [ ] Enter the code, finish the setup steps, and you land in the customer admin already signed in (no second code).
- [ ] Close the tab, open the **admin sign-in**, enter that email: a new code arrives and signs you in.
- [ ] Sign out, request a code again for the same email: you get a new email and the **old code no longer works**.
- [ ] Request a code for an email address that has **no account**. The screen looks exactly the same as for a real one,
      and no email arrives. (This is deliberate.)
- [ ] Try signing up again with the test account's email. You see the same "check your email" page; the email you receive says
      "You already have an account". No second account is created.
- [ ] In the admin, add a **staff member** using an address you can read. On the **staff kiosk**, sign in with it. A code arrives
      by email only.
- [ ] In Resend, open **Emails**: your test sends are listed as **Delivered**.
- [ ] Type a wrong code 5 times: the code stops working and you must request a new one.
- [ ] (Optional) In Railway logs, confirm no 6-digit codes and no key text appear. They are never logged.

If a check fails, see "When something looks wrong" below.

## Part 7 - Later: WhatsApp (when the Meta business account is approved)

Nothing here is needed to launch with email. When you are ready, in **Meta for Developers** create/open your
WhatsApp Business app and note: the **Phone number ID**, a **permanent access token**, and the **App Secret**
(App settings -> Basic). Invent a **verify token** (any long random text, e.g. from Part 4). Then add to Railway:

| Name | Value |
|---|---|
| `WHATSAPP_PROVIDER` | `meta-cloud` |
| `WHATSAPP_TOKEN` | the permanent access token |
| `WHATSAPP_PHONE_ID` | the Phone number ID |
| `WHATSAPP_APP_SECRET` | the App Secret (used to check that messages really come from Meta) |
| `WHATSAPP_VERIFY_TOKEN` | the text you invented |

In Meta's WhatsApp **Configuration -> Webhook**, set the callback URL to
`https://<your-api-address>/api/whatsapp/webhook` and the verify token to your invented text, press **Verify and save**,
then subscribe to the **messages** field. The server checks Meta's signature on every message and ignores anything unsigned.
In production it refuses all WhatsApp calls until `WHATSAPP_APP_SECRET` is set.

## When something looks wrong

| You see | It means | What to do |
|---|---|---|
| "Sign-in by email isn't switched on for this service yet" | Email settings are missing or `EMAIL_PROVIDER` is not `resend` | Check Part 5 variables, then the Deploy Logs banner |
| "We couldn't send the code just now. Please try again" | Resend refused or was unreachable | In Resend open **Logs**. Usually: domain not verified yet, wrong `EMAIL_FROM` domain, or the API key was deleted. A short Resend outage also causes this; retrying works. Failed attempts do not count against the user's limits |
| Emails go to spam | Domain records incomplete | Finish Part 2 including DMARC; send a few real messages over a few days |
| Everyone was signed out after a change | `JWT_SECRET` changed | Expected; they sign in again |
| "Too many sign-in code requests" | Safety limit: 10 codes per address and 12 per connection in 10 minutes | Wait ten minutes |
| A code is on screen again | `DEMO_MODE` is `true`, or `NODE_ENV` is `test` | Remove `DEMO_MODE`; set `NODE_ENV=production` |

**Signing someone out everywhere.** The server can end every session of an account at once (an owner can do it for their
own account, or for one staff member; switching a staff member off does it automatically). It is available to the apps as
`POST /api/auth/sign-out-everywhere` and `POST /api/auth/staff/<id>/sign-out`; there is no button for it yet. In an emergency,
with database access you can run `update tenants set token_version = token_version + 1;` to sign every owner out.

## Settings reference

| Name | What it does | Default |
|---|---|---|
| `NODE_ENV` | `production` on the live server. Anything else lets some safety checks relax | unset |
| `EMAIL_PROVIDER` | `resend` (real email) or `log` (nothing sent; development/demo only) | `log` outside production, none in production |
| `RESEND_API_KEY` | Resend key | - |
| `RESEND_API_URL` | Only to point at a test double | `https://api.resend.com/emails` |
| `EMAIL_FROM` | Sender, `Name <address@verified-domain>` | - |
| `EMAIL_REPLY_TO` | Where replies go | none |
| `APP_NAME` | Product name in emails | `QBooker` |
| `EMAIL_BRAND_COLOR` | Accent colour in emails, `#RRGGBB` | `#1D5C8A` |
| `DEFAULT_LANG` | Language of emails when none is asked for (only `en` exists today) | `en` |
| `EMAIL_TIMEOUT_MS` / `EMAIL_RETRY_DELAY_MS` | How long to wait for Resend / pause before the one retry | 8000 / 400 |
| `DEMO_MODE` | `true` = the log provider may show codes on screen. **Never in production** except a private demo | unset |
| `JWT_SECRET` | Signs sessions. Long and random | required |
| `OTP_PEPPER` | Scrambles stored codes (falls back to `JWT_SECRET`) | unset (warning in production) |
| `OTP_TTL_MINUTES` | How long a code lives | 10 |
| `ADMIN_SESSION_HOURS` / `STAFF_SESSION_HOURS` | Owner / staff session length, renewed while in use | 12 / 16 |
| `SESSION_MAX_DAYS` | Hard limit for one sign-in even when always in use | 30 |
| `SIGNUP_IP_MAX` | Sign-ups per connection per 10 minutes | 30 |
| `TRUST_PROXY` | Number of gateways in front of the server | 1 |
| `WHATSAPP_PROVIDER` | `log` or `meta-cloud` | `log` |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | See Part 7 | - |
| `WHATSAPP_API_URL`, `WHATSAPP_API_VERSION` | Only if Meta changes address/version | `https://graph.facebook.com`, `v21.0` |
| `WHATSAPP_WEBHOOK_RATE_PER_MIN` | Webhook calls allowed per sender address per minute | 600 |

---

## Going global: what is ready, and what is not

**Already configurable (no code changes):**

* Email provider and sender identity (`EMAIL_PROVIDER`, `EMAIL_FROM`, `APP_NAME`, brand colour), and a clean place to add
  more providers (Amazon SES, Postmark, SMTP...): one small file, nothing else changes.
* WhatsApp provider and credentials (`WHATSAPP_*`); more providers can be added the same way.
* Wording of every email and WhatsApp reply the server sends lives in one catalogue (`server/src/lib/i18n.js`). Adding
  French, Arabic, etc. is adding one block of text. The sign-in screens can already ask for a language
  (`lang`, or the browser's language) and the server falls back to English.
* Sign-in has no phone-number or country assumptions: it is email only.
* Session lengths, code lifetime, rate limits.

**Not yet global (known gaps, do before launching in a new country):**

* **Only English text.** The catalogue is wired for more languages, but the apps' screens (customer, staff, admin, marketing) are
  English-only, and an account has no stored preferred language yet.
* **UK assumptions elsewhere in the product:** the admin console flags sign-ups from outside the UK ("Outside UK"); prices and VAT are
  built for pounds and UK VAT; the marketing copy talks about the NHS; the business day is anchored to London time (the time-zone
  work in progress addresses this per location).
* **Email only for sign-in.** In regions where email is unreliable or rarely used, sign-in by WhatsApp or SMS code would be needed; the
  sender interfaces make that straightforward but it is not built.
* **One email provider implemented (Resend).** Check it delivers well in each target country (some national mail providers are
  strict); add a second provider if needed.
* **Data location and law.** The database lives wherever the Supabase project was created. Health-related queue data may carry
  national rules (UK GDPR, EU GDPR, HIPAA, local health-data laws). Choose the region deliberately and get advice per market.
* **Phone numbers** are stored as received; they are not yet normalised to international format (E.164) before being matched.
* **Country look-up for sign-ups** uses a bundled IP database (no outside calls); it is only informational.
