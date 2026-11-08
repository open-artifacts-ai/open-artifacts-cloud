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
  -- A checkout is ordered against other checkouts only, never against the
  -- subscription's events (its own key, like invoices).
  last_checkout_created INTEGER,
  -- Solo's 30-day no-card trial end (ms): the Solo subscription's own trial,
  -- never the 14-day Business trial's trial_ends_at.
  solo_trial_ends_at INTEGER,
  -- The Solo subscription's state while the 14-day Business trial runs over
  -- it (tier trial): the trial's own tier, status and dates stay the row's,
  -- and this is what the row becomes when the trial ends (null: no Solo
  -- subscription, so lapsed). Only meaningful while tier is trial.
  solo_status TEXT CHECK (solo_status IN ('active', 'past_due', 'lapsed')),
  solo_grace_until INTEGER,
  -- The install's open Checkout session (cs_ id) and the idempotency key it
  -- was made with: expired before another is created, so two paid sessions
  -- are nearly impossible.
  open_checkout_id TEXT,
  open_checkout_key TEXT
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

-- Subscriptions the webhook still has to cancel in Stripe: the one an upgrade
-- replaced, or a paid subscription the row did not adopt. Written in the same
-- batch as the event that caused it; every webhook for the customer settles
-- all of them, and a row goes only after its own cancel succeeded.
CREATE TABLE pending_cancels (
  subscription_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL
);
CREATE INDEX pending_cancels_customer ON pending_cancels (customer_id);
