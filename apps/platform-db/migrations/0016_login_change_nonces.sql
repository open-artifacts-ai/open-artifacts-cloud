-- Login-domain change from an instance (open-artifacts#2520 slice 3): the
-- signed request's nonce, stored per install so a replay inside the
-- assertion's skew window is a 409 and never applies twice. A row is only
-- needed for the window (the route prunes rows older than ten minutes when it
-- inserts). No foreign key; nothing else references the table. Additive.
CREATE TABLE IF NOT EXISTS login_change_nonces (
  install_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (install_id, nonce)
);
CREATE INDEX IF NOT EXISTS login_change_nonces_at ON login_change_nonces (at);
