-- Email Service bounce and complaint events, routed to the sending install
-- (open-artifacts#2650). The platform's queue consumer stores one row per
-- event; the install pulls its own rows through the LoginGate and acks them.
-- No recipient and no subject is stored: only what the install needs to match
-- its own message id. `seq` orders rows (oldest first) and bounds the cap of
-- 1000 per install; `event_id` is unique, so a redelivered event is a no-op.
-- Rows are pruned after 14 days. No foreign key; additive.
CREATE TABLE IF NOT EXISTS email_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bounced', 'complained')),
  bounce_type TEXT CHECK (bounce_type IS NULL OR bounce_type IN ('hard', 'soft')),
  event_id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_events_install ON email_events (install_id, seq);
CREATE INDEX IF NOT EXISTS email_events_at ON email_events (at);
