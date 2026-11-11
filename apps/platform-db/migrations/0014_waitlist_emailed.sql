-- Private beta (#2096): when the approval email went out. NULL on an approved
-- row means it never sent (or failed), so approving that row again resends
-- instead of answering "already approved". Additive; no backfill.
ALTER TABLE signup_waitlist ADD COLUMN emailed_at INTEGER;
