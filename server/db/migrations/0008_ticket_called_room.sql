-- Which room/desk called each ticket, so an in-progress ticket can be picked back up by the same
-- room (or taken over) if the staff member's browser was closed.
alter table tickets add column if not exists called_room text;
