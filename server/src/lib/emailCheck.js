import dns from "dns";

const resolveMx = dns.promises.resolveMx;

// Confirms the email's domain can actually receive mail (catches typos and made-up domains)
// without sending anything — a real MX lookup, not a format regex. Fails open on anything
// that isn't a clear "this domain has no mail server" result (timeouts, resolver hiccups,
// etc.), so a flaky DNS lookup never blocks a genuine signup.
export async function domainAcceptsMail(email) {
  const domain = String(email || "").split("@")[1];
  if (!domain) return false;
  try {
    const records = await resolveMx(domain);
    return records.length > 0;
  } catch (err) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") return false;
    return true; // inconclusive (timeout, resolver issue, etc.) — don't block on our own failure
  }
}
