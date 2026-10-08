-- tickets.visit_date used to default to current_date, i.e. the DATABASE session's date (UTC on Supabase),
-- which is yesterday for the first hour of British Summer Time. The API always supplies visit_date
-- explicitly (from the Europe/London business date), but any other writer (psql, a future route, a bulk
-- import) must land on the same business day, so the default is the London calendar date too.
alter table tickets alter column visit_date set default ((now() at time zone 'Europe/London')::date);
