-- Self-serve trial-ending reminders (cloud #39, #41): one row per install and
-- kind, written by the scheduler before the email is sent, so each goes out at
-- most once. kind is 'week' (the trial ends in 1 to 7 days) or 'last_day' (it
-- ends within a day); an install gets at most one of each.
-- trial_ends_at is billing's solo_trial_ends_at when the row was claimed.
-- claimed_at is the claim; sent_at is set once the send was accepted. A row
-- with no sent_at long after claimed_at means the email may not have gone out
-- (the scheduler emails the operator); delete the row to let it be sent again.
-- Holds no email address and no customer data. Additive; re-runnable.
CREATE TABLE IF NOT EXISTS trial_reminders (
  install_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('week', 'last_day')),
  trial_ends_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (install_id, kind)
);
