-- Self-serve trial-ending reminder (cloud #39): one row per install, written
-- by the scheduler before the email is sent, so it goes out at most once.
-- trial_ends_at is billing's solo_trial_ends_at when the row was claimed.
-- claimed_at is the claim; sent_at is set once the send was accepted. A row
-- with no sent_at long after claimed_at means the email may not have gone out
-- (the scheduler emails the operator); delete the row to let it be sent again.
-- Holds no email address and no customer data. Additive; re-runnable.
CREATE TABLE IF NOT EXISTS trial_reminders (
  install_id TEXT NOT NULL PRIMARY KEY,
  trial_ends_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER
);
