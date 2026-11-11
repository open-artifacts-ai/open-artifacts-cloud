-- Private beta gate (SIGNUPS_ENABLED=invite, #2096): who may sign up, and who
-- asked to. signup_allowlist.entry is a lowercased email, or "@domain" for a
-- whole domain (matched exactly, never by suffix). signup_waitlist is keyed by
-- the Google sub; approving someone adds an allowlist entry, it never edits
-- signups or installs. Neither table has a foreign key, and nothing else
-- references them: removing an entry never touches an existing install or
-- sign-up. Additive; no backfill.
CREATE TABLE signup_allowlist (
  entry TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE signup_waitlist (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  note TEXT,
  joined_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'approved', 'declined')),
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX signup_waitlist_status ON signup_waitlist (status, joined_at);
