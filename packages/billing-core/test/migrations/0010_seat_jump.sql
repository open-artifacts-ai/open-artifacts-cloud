-- A big member jump billed at once (#2588, #2940): the owner's notice must not
-- depend on one /seats response arriving. The jump is kept on the seats row
-- (jump_from is the count before the first unacknowledged jump, jump_to the
-- count after the latest, jump_at when it was billed) and every /seats answer
-- for the install carries it until the instance echoes jump_at back as
-- `jumpAck` (cleared then), or after seven days (cleared, logged).
-- correction_pending is 1 from a checkout's count correction until an apply
-- lands: what Stripe held before it is not a jump's "from".
-- Forward only; no existing row changes.
ALTER TABLE seats ADD COLUMN jump_from INTEGER;
ALTER TABLE seats ADD COLUMN jump_to INTEGER;
ALTER TABLE seats ADD COLUMN jump_at INTEGER;
ALTER TABLE seats ADD COLUMN correction_pending INTEGER NOT NULL DEFAULT 0;
