# QBooker: things to do before real users go live

Nobody outside testing is live yet. This is the running list of what has to be finished first. Tick items off as they are done.
Last updated: 9 October 2026.

## Documents the NHS buyers page says we provide (they must exist before the first enquiry)
- [ ] Data processing agreement for customers
- [ ] Data protection impact assessment (DPIA) for the data described on the NHS buyers page
- [ ] One-page security summary
- [ ] Answers to the DTAC questionnaire
- [ ] Have a data protection adviser review the documents above, the privacy notice and the NHS buyers page
- [ ] Clinical safety position (DCB0129): confirm with an adviser whether it applies, and what to say

## Company and legal
- [ ] Register the company at Companies House, then add the company details to the privacy notice and NHS page (decision so far: the company name is not listed publicly)
- [ ] Check whether the ICO data protection fee applies, and pay it
- [ ] Take the "Draft" banner off the privacy notice, once an adviser has reviewed it and the "Last updated" date is added
- [ ] Add any security certifications (for example Cyber Essentials) only once they are real

## Hosting (privacy notice and NHS page already say UK)
- [ ] Move the API (currently Railway, US) to a UK region
- [ ] Move the database (currently Supabase, Ireland) to a UK region
- [ ] Check where the email provider (Resend, Ireland) and any WhatsApp provider process data, and update the privacy notice to match
- [ ] Custom domain for the API (needs a paid Railway plan; today it uses the railway.app address)

## WhatsApp
- [ ] Get the Meta business portfolio un-restricted (Support Inbox appeal), then verify the business once the company exists
- [ ] Add a second admin to the Meta business account
- [ ] Production number (not already on WhatsApp), display name, system user token, webhook and verify token; set the WHATSAPP_* values in Railway and VITE_WHATSAPP_NUMBER on the patient app
- [ ] Test the full flow on a real phone: tap Send, connected message, "you're next", "your turn", STOP, deletion at end of day
- [ ] Decide on a fallback messaging provider if Meta will not lift the restriction
- [ ] Do not add a payment method to the Meta ad account unless it is needed

## Website and contact
- [ ] Set up the support@qbooker.co.uk mailbox properly (the inbox exists in Resend; decide who reads it)
- [ ] Confirm the Log in button on the home page opens app.qbooker.co.uk
- [ ] Test sign-up on www.qbooker.co.uk end to end, and open join. and staff. on a phone

## Data retention (set, but to be confirmed)
- [ ] Confirm the deletion periods: tickets 30 days, scrambled identifiers 48 hours, activity logs 90 days, message log 7 days, sign-in codes 1 day after expiry. Clinics only see 30 days of ticket history under this setting
- [ ] Keep the NHS buyers page and privacy notice in step with the periods set in Railway (RETENTION_* settings)

## Full testing (saved for the end)
- [ ] Run all server test suites (api, booking-rules, gaps, system with a morning test clock, auth-email, whatsapp-link)
- [ ] Run the full browser journeys (A to E, phone and desktop)
- [ ] Load test and security review before the first customer
