-- Account hardening.
-- 1) token_version: bumping it signs a person out everywhere (every session token carries the version it was
--    issued under; a token whose version no longer matches is refused). Used by "sign out everywhere", by
--    switching a staff member off, and as the building block for any future "revoke sessions" feature.
alter table tenants       add column if not exists token_version integer not null default 0;
alter table staff_members add column if not exists token_version integer not null default 0;

-- 2) Sign-in codes are now stored as a keyed hash (HMAC-SHA256, 64 hex characters), never in clear. Any code
--    still waiting from before this change is in clear text and would no longer verify anyway, so remove it.
delete from admin_otp;
delete from staff_otp;

-- 3) The simulated message log used to keep the full text of sign-in emails, codes included. Scrub those.
update simulated_messages
   set body = '[sign-in code removed]'
 where channel = 'email' and body ~* 'sign-in code';
