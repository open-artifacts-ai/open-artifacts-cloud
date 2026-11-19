-- A big member jump billed at once (#2588, #2940): the owner's notice must not
-- depend on one /seats response arriving. The jump is kept on the seats row
-- (jump_from is the count before the first unreported jump, jump_to the count
-- after the latest, jump_at when it was billed) and every /seats answer for
-- the install carries it until two answers have carried it (jump_sent counts
-- the answers that did), then it is cleared.
-- Forward only; no existing row changes.
ALTER TABLE seats ADD COLUMN jump_from INTEGER;
ALTER TABLE seats ADD COLUMN jump_to INTEGER;
ALTER TABLE seats ADD COLUMN jump_at INTEGER;
ALTER TABLE seats ADD COLUMN jump_sent INTEGER NOT NULL DEFAULT 0;
