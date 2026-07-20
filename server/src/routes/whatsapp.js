import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();

// --- WhatsApp webhook (stub) --------------------------------------------------------
// This is where a real WhatsApp Business Platform / BSP (Twilio, 360dialog, etc.) would
// POST inbound messages once that's connected. Nothing calls this yet — it exists to show
// the intended architecture: look up (or refresh) which tenant/location a phone number
// belongs to based on the location code they most recently sent, then route the rest of
// the conversation the same way the /customer app's chat logic already does.
//
// The exact payload shape depends entirely on which BSP you end up using — the
// destructuring below assumes a simplified { from, text } shape and will need adapting.
router.post("/webhook", asyncHandler(async (req, res) => {
  const { from, text } = req.body; // TODO: adapt to your BSP's actual webhook payload shape

  if (!from || !text) return res.status(400).json({ error: "Missing from/text." });

  const codeMatch = text.trim().toUpperCase().match(/QB-[A-Z0-9]{6}/);
  if (codeMatch) {
    const lookup = await query(`select tenant_id, location_id from location_codes where code = $1`, [codeMatch[0]]);
    if (lookup.rows.length > 0) {
      const { tenant_id, location_id } = lookup.rows[0];
      await query(
        `insert into whatsapp_sessions (phone_number, tenant_id, location_id, updated_at)
         values ($1,$2,$3, now())
         on conflict (phone_number) do update set
           tenant_id = excluded.tenant_id, location_id = excluded.location_id, updated_at = now()`,
        [from, tenant_id, location_id]
      );
      // TODO: send a real WhatsApp reply here via your BSP's send-message API — e.g.
      // "Which service would you like today?" with that tenant's service list as quick replies.
      return res.json({ ok: true, matchedCode: codeMatch[0] });
    }
  }

  // No code in this message — fall back to whichever business/location they last scanned.
  const session = await query(`select * from whatsapp_sessions where phone_number = $1`, [from]);
  if (session.rows.length === 0) {
    // TODO: send "Hi! To get started, scan the QR code at the location you're visiting."
    return res.json({ ok: true, noSession: true });
  }

  // TODO: real conversation-state handling belongs here — mirroring the
  // greet -> choose service -> join queue / book slot flow already built in /customer,
  // but server-side and persisted between webhook calls (each call is stateless, so you'd
  // want a `conversation_state` column here, or a separate table, tracking where each
  // phone number currently is in the flow).
  res.json({ ok: true, session: session.rows[0] });
}));

export default router;
