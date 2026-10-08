-- 0020: verify the email address BEFORE an account is created.
-- Sign-up now starts with name + email; a code is emailed, and only a verified address can go on to create the account.
-- One row per code sent. Codes are stored as a keyed hash, expire, and die after too many wrong guesses, like admin_otp.
create table if not exists signup_otp (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_signup_otp_email on signup_otp (lower(email), created_at desc);
alter table signup_otp enable row level security;
