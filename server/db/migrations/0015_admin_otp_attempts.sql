-- Wrong-guess counter for tenant-admin sign-in codes (staff_otp already has one): after a handful
-- of wrong guesses the code is dead, so a 6-digit code can't be brute-forced.
alter table admin_otp add column if not exists attempts integer not null default 0;
