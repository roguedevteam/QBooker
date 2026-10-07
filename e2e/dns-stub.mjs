// Preloaded (node --import) into the PRIVATE API instance the e2e suite spawns.
// The server's signup / add-staff routes reject any email whose domain has no MX record (lib/emailCheck.js).
// Sandboxes without working DNS therefore cannot create accounts or staff at all, so for the test instance only
// we answer every MX lookup positively. No server source is touched.
import dns from "node:dns";
dns.promises.resolveMx = async (domain) => [{ exchange: `mail.${domain}`, priority: 10 }];
