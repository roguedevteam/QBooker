import { useEffect } from "react";
import { SUPPORT_EMAIL, mailto } from "./lib/config.js";

// Information for NHS and healthcare buyers. Only statements that are true of the product today go here.
// TO ADD AT OFFICIAL GO-LIVE (left out of the public text for now): the operator's company name, registered address and company number;
// a data processing agreement; independent security testing / certifications (e.g. Cyber Essentials); the data protection impact
// assessment, security summary and DTAC answers; the clinical safety position (e.g. DCB0129); and a check that the retention periods
// below still match what is configured on the server (lib/retention.js).
function Section({ title, children }) {
  return (
    <section className="pv-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const RETENTION = [
  ["Queue tickets (ticket number, service, location, status and times; no names)", "30 days"],
  ["Scrambled device and connection identifiers used to stop one phone taking many places", "48 hours"],
  ["Optional WhatsApp mobile number", "Deleted when the visit ends, on STOP, and by the end of the day (24 hours at the latest)"],
  ["Organisation activity log (ticket numbers, never names)", "90 days"],
  ["Sign-in codes", "Short-lived; deleted one day after they expire"],
  ["Message log", "7 days"],
];

export default function NHSBuyers() {
  useEffect(() => {
    document.title = "Information for NHS and healthcare buyers — QBooker";
    return () => {};
  }, []);

  return (
    <div className="pv">
      <header className="pv-head"><div className="pv-wrap"><a href="/" className="pv-back">← QBooker home</a></div></header>
      <main id="main" className="pv-wrap pv-main">
        <h1>Information for NHS and healthcare buyers</h1>
        <p className="pv-lead">
          QBooker runs same-day queues and appointments for clinics, with optional WhatsApp updates. It was designed to hold as little
          as possible about patients. This page sets out what it holds, for how long, and how it is protected.
        </p>

        <Section title="What patients do">
          <p>
            A patient scans a QR code at the clinic and joins the queue on their phone. They get a ticket number and see their place in line.
            They are never asked for a name, date of birth, NHS number, address or reason for their visit, and they do not need an account or an app.
          </p>
        </Section>

        <Section title="What QBooker holds about patients">
          <ul>
            <li>A ticket number, the service and location, the ticket's status (waiting, called, seen, cancelled, no-show) and the times it changed.</li>
            <li>Two scrambled identifiers, kept for 48 hours, that stop one phone taking many places. They cannot be turned back into the original values.</li>
            <li>
              <strong>Only if the patient chooses WhatsApp updates:</strong> their mobile number. They never type it in. WhatsApp opens with a code ready,
              and when they press Send we receive the number it came from. It is deleted when the visit ends, when they reply STOP, and by the end of the day.
            </li>
          </ul>
          <p><strong>Not held, at any stage:</strong> names, dates of birth, NHS numbers, addresses, appointment reasons, symptoms, test results or any clinical record. QBooker has no field for them.</p>
        </Section>

        <Section title="How long data is kept">
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead><tr><th>Data</th><th>Kept for</th></tr></thead>
              <tbody>{RETENTION.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}</tbody>
            </table>
          </div>
          <p>Deletion is automatic. When an organisation closes its account, its locations, services, tickets and logs are permanently removed.</p>
        </Section>

        <Section title="Roles under data protection law">
          <p>
            The clinic decides why and how queue data is used, so it is the controller. QBooker is its processor and acts on the clinic's instructions.
            For the staff and administrators who sign up, QBooker is the controller of their name and work email address.
           
          </p>
        </Section>

        <Section title="Security">
          <ul>
            <li>All traffic is encrypted (HTTPS), and each organisation can only see its own queues and staff.</li>
            <li>Administrators and staff sign in with a six-digit code sent to their email. Codes are short-lived, stored scrambled, and stop working after a few wrong tries. New accounts must confirm their email address first.</li>
            <li>Sessions expire. An administrator can sign every device out at once, and switching a staff member off ends their session straight away.</li>
            <li>Patient tickets are opened with a long random link, not a guessable number, and the service limits repeated guessing.</li>
            <li>The WhatsApp connection only accepts messages that WhatsApp has digitally signed.</li>
            <li>A WhatsApp number can be attached to a ticket only by sending that ticket's code, and a second number cannot take it over.</li>
          </ul>
        </Section>

        <Section title="Where data is hosted">
          <p>
            QBooker's database and servers run in UK data centres, so patient queue data stays in the UK. Sign-in codes for staff and administrators are sent by an email provider based in Ireland.
            The full list of providers and where they operate is in our <a href="/privacy">privacy notice</a>.
          </p>
        </Section>

        <Section title="Clinical safety">
          <p>
            QBooker does not hold clinical information and does not make or influence clinical decisions. It tells a patient where they are in a queue and when they are called.
          </p>
        </Section>

        <Section title="Documents and contact">
          <p>To ask a question, or to talk through what your organisation needs, email <a href={mailto("NHS buyer enquiry")}>{SUPPORT_EMAIL}</a>.</p>
        </Section>
      </main>
    </div>
  );
}
