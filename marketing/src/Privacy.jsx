import { useEffect } from "react";
import { SUPPORT_EMAIL, mailto } from "./lib/config.js";

// Set to false to remove the "Draft" banner once the notice has been reviewed by a qualified adviser.
export const SHOW_DRAFT_BANNER = true;

// Locations were checked against the live hosting settings. Items still marked "to be confirmed" need the founder's input before launch.
const SUBPROCESSORS = [
  { name: "Railway", purpose: "Runs the QBooker API (the server that handles queue and account requests)", location: "United States (San Francisco)" },
  { name: "Supabase", purpose: "Stores account and queue data (the database)", location: "Ireland (EU West)" },
  { name: "Render", purpose: "Hosts the QBooker web apps (static files only, no patient data is stored there)", location: "Global content delivery network" },
  { name: "Resend", purpose: "Sends sign-in codes and service emails to staff and administrators", location: "Ireland (EU West)" },
  { name: "WhatsApp / Meta (and any messaging provider)", purpose: "Carries the optional WhatsApp updates, and sees the mobile number and message. Only where you choose WhatsApp. Not yet in live use", location: "To be confirmed" },
  { name: "QR code image service (api.qrserver.com)", purpose: "Draws the QR code on printable posters. Receives the public join link for a service, never patient data. We intend to replace this with in-house generation", location: "To be confirmed" },
  { name: "Google Fonts", purpose: "Delivers the typefaces used by our web pages. Your browser contacts Google when a page loads", location: "Global" },
];

function Section({ title, children }) {
  return (
    <section className="pv-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Privacy() {
  useEffect(() => { document.title = "Privacy notice — QBooker"; }, []);

  return (
    <div className="pv">
      {SHOW_DRAFT_BANNER && (
        <div className="pv-banner" role="note">
          <strong>Draft</strong> — to be reviewed by a qualified adviser before launch.
        </div>
      )}
      <header className="pv-head">
        <div className="pv-wrap">
          <a href="/" className="pv-back">← QBooker home</a>
        </div>
      </header>
      <main id="main" className="pv-wrap pv-main">
        <h1>Privacy notice</h1>
        <p className="pv-meta">Last updated: [date to be added when approved]</p>
        <p className="pv-lead">
          This explains what personal information QBooker handles, why, who else sees it and how to exercise your rights.
          We have kept it in plain English, and we have tried to keep what we store to a minimum.
        </p>

        <Section title="1. Who is responsible for what">
          <p>
            <strong>Patient and visitor queue data.</strong> When someone joins a queue or books a slot, the clinic or organisation
            that runs that service decides why and how the data is used. That organisation is the "controller". QBooker acts as its
            "processor": we store and handle the data on the organisation's instructions, to run the queue.
          </p>
          <p>
            <strong>Customer account data.</strong> For the people who sign up to QBooker on behalf of an organisation, and the staff
            they add, QBooker is the controller of the account details described below.
          </p>
          <p>Operator details: [QBooker legal entity name, registered address and company number to be added].</p>
        </Section>

        <Section title="2. Patient and visitor queue data">
          <p><strong>What we store when you join a queue or book a slot:</strong></p>
          <ul>
            <li>A ticket number (for example "BT-014"), the service, location, date, type (walk-in or booked), time slot where relevant, and the status of the ticket (waiting, called, seen, completed, cancelled, no-show) with the times it changed.</li>
            <li>The name and room of the staff member who called the ticket, where that happens.</li>
            <li>A random access key that lets your phone show your ticket again. It is kept in your browser's storage and in the page address.</li>
            <li>To stop abuse (one phone taking many places): a one-way scrambled "hash" of a random identifier held in your browser, and a one-way hash of your internet connection address (IP address). We do not keep the readable identifier or address, but a hash is still treated as personal data because it can single out a device.</li>
            <li>Whether you asked for optional WhatsApp updates (a yes/no flag and when you asked), and, only if you connect WhatsApp, the mobile number you messaged from. See the box below.</li>
            <li>A line in the organisation's activity log, for example "Ticket BT-014 joined the queue". Logs record ticket numbers, not names.</li>
          </ul>
          <p><strong>What we do not store:</strong> patient names, dates of birth, NHS or other health numbers, addresses, appointment reasons, symptoms, test results or any clinical record. QBooker does not ask for them. Organisations should not type this information into any QBooker field.</p>
          <div className="pv-callout">
            <p>
              <strong>WhatsApp updates (optional): the only thing we hold is your mobile number.</strong> We never ask you to type your number in.
              If you tap "Get updates on WhatsApp", WhatsApp opens with a short code already written. When you press Send, WhatsApp tells us which mobile
              number sent it, and we attach that number to your ticket so we can message you when you are nearly up and when it is your turn.
            </p>
            <ul>
              <li>No name, date of birth, NHS number, address, reason for visit, symptoms or any other health or personal detail is collected or stored. Not at any stage.</li>
              <li>We do not read or store your WhatsApp profile name, photo or contacts, and we do not keep the text of your messages. We only look for the ticket code, or the word STOP.</li>
              <li>Our messages contain only your ticket number and, when you are called, the room.</li>
              <li><strong>When your number is deleted:</strong> straight away if you reply STOP; when your ticket is completed, seen or cancelled; and in any case at the end of the same day (midnight at the location) and no later than 24 hours after you connected. If you were marked as not turning up, we keep the number until the end of the day so the clinic can put you back in the queue.</li>
              <li>You can stop at any time by replying STOP. Your place in the queue is not affected, and you can still follow your ticket on the web page.</li>
              <li>This service is for same-day queues only. We do not send reminders for future days.</li>
            </ul>
            <p>
              Your message is carried by WhatsApp / Meta, which handles it under its own privacy policy. We have no control over what they keep.
              [Confirm the final WhatsApp provider and its data location before enabling this.]
            </p>
          </div>
        </Section>

        <Section title="3. Account and staff data">
          <p>For each customer account and for the staff members an administrator adds, we hold:</p>
          <ul>
            <li>Names and email addresses (used to send one-time sign-in codes and to contact you about the service).</li>
            <li>Business name, optional business address and website, and the locations and services you set up.</li>
            <li>Billing details: the billing email and purchase-order reference, licence purchases and receipts. Card payments are not yet live; when they are, card details will be handled by a payment provider and not stored by us [to be confirmed].</li>
            <li>Sign-in activity: one-time codes and attempts (short-lived), and an activity log of changes made in the account.</li>
          </ul>
          <p>We use this to provide and secure the service, to bill, to give support and to meet our legal obligations. Our lawful bases are performance of the contract, our legitimate interests in running and securing the service, and legal obligation. [Adviser to confirm.]</p>
        </Section>

        <Section title="4. Cookies and similar storage">
          <p>
            We do not use advertising or analytics cookies. The apps use your browser's local storage for things the service needs:
            keeping you signed in (staff and administrators), remembering your ticket on your phone, and the random per-browser
            identifier used for abuse prevention described above. [Adviser to confirm no consent banner is required.]
          </p>
        </Section>

        <Section title="5. How long we keep data">
          <p>
            Retention schedule to be confirmed. At present QBooker does not automatically delete queue tickets, activity logs or
            sign-in records after a set period. Data is removed when an organisation deletes its account, which permanently removes
            its locations, services, tickets and logs (we keep only an anonymised revenue summary with no names or emails).
            WhatsApp mobile numbers are different: they are deleted as soon as a visit ends, and always by the end of the day (see section 2).
            Before launch we will set and publish fixed periods for queue tickets (we expect these to be short, measured in days or weeks),
            activity logs and sign-in records.
          </p>
        </Section>

        <Section title="6. Who we share data with (sub-processors)">
          <p>We use the following providers to run QBooker. Items marked "to be confirmed" are placeholders until contracts and regions are settled.</p>
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead><tr><th>Provider</th><th>What it does</th><th>Location</th></tr></thead>
              <tbody>
                {SUBPROCESSORS.map((s) => (
                  <tr key={s.name}><td>{s.name}</td><td>{s.purpose}</td><td>{s.location}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>We do not sell personal data. We share it with the organisation that runs the service you used, with the providers above, and with authorities where the law requires.</p>
        </Section>

        <Section title="7. International transfers">
          <p>
            Our database and email provider are in Ireland. Our API host currently runs in the United States, so queue and account data is processed there
            when you use the service. We rely on a lawful transfer mechanism, such as an adequacy decision or approved standard contractual clauses [adviser to confirm],
            and we intend to move the API to a UK or EU region. Locations are listed in the table above.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            Data is encrypted in transit (HTTPS). Access is limited by organisation, so staff only see their own organisation's queues, and sign-in uses short-lived one-time codes.
            No system is perfectly secure; if a breach affects personal data we will tell the affected organisations and the regulator as the law requires.
          </p>
        </Section>

        <Section title="9. Your rights">
          <p>
            Depending on where you live, you may have the right to be informed about, access, correct, delete, restrict or object to the use of your personal data, to
            data portability, and to complain to your data protection regulator (in the UK, the Information Commissioner's Office, ico.org.uk).
          </p>
          <p>
            If you used a queue or booking, ask the organisation running that service first, because it is the controller; we will help it respond. Because we do not store your name,
            we may need your ticket number, the service and the date to find a record. For account data, or if you are unsure who to ask, contact us at{" "}
            <a href={mailto("Privacy request")}>{SUPPORT_EMAIL}</a>.
          </p>
        </Section>

        <Section title="10. Changes and contact">
          <p>We will post changes to this page and update the date above. Questions: <a href={mailto("Privacy question")}>{SUPPORT_EMAIL}</a>.</p>
        </Section>
      </main>
    </div>
  );
}
