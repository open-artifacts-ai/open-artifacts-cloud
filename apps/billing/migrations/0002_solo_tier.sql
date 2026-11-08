-- Solo (#1568): tiers.tier may now be 'solo'. SQLite cannot change a CHECK in
-- place, so the table is rebuilt with the same columns (free stays: rows made
-- before Solo keep it, and the install treats it as Solo's rules). Forward
-- only; no row changes.
CREATE TABLE tiers_new (
  install_id TEXT PRIMARY KEY,
  tier TEXT CHECK (tier IN ('free', 'solo', 'trial', 'team', 'business')),
  status TEXT CHECK (status IN ('active', 'past_due', 'lapsed', 'suspended')),
  trial_ends_at INTEGER,
  grace_until INTEGER,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_read_at INTEGER,
  updated_at INTEGER NOT NULL,
  last_event_created INTEGER,
  last_invoice_created INTEGER,
  -- Solo's 30-day no-card trial end (ms): the Solo subscription's own trial,
  -- never the 14-day Business trial's trial_ends_at.
  solo_trial_ends_at INTEGER
);

INSERT INTO tiers_new (
  install_id, tier, status, trial_ends_at, grace_until, stripe_customer_id,
  stripe_subscription_id, version, last_read_at, updated_at,
  last_event_created, last_invoice_created
) SELECT
  install_id, tier, status, trial_ends_at, grace_until, stripe_customer_id,
  stripe_subscription_id, version, last_read_at, updated_at,
  last_event_created, last_invoice_created
FROM tiers;

DROP TABLE tiers;
ALTER TABLE tiers_new RENAME TO tiers;
