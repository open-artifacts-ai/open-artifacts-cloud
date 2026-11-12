-- Yearly prepaid seats (#2235): the overage billed for a closed month, once
-- per (install, month). The row is written before the first Stripe call and
-- moves forward as each step lands (item_created, invoice_created, invoiced),
-- so a retry finishes the invoice and never adds a second item. A month that
-- is invoiced is never billed again, whatever a later report counts.
-- Forward only; no row changes.
CREATE TABLE overage (
  install_id TEXT NOT NULL,
  month TEXT NOT NULL,
  seats INTEGER NOT NULL,
  creators INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_amount INTEGER NOT NULL,
  item_id TEXT,
  invoice_id TEXT,
  outcome TEXT NOT NULL,
  -- Bumped each time the row is reset after Stripe lost its invoice; part of
  -- every idempotency key, so a reset never replays a deleted invoice's key.
  generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, month)
);
