-- Retrying unapplied months (#2210, #2246). usage.retried_at: when the daily
-- cron last re-tried a closed month (oldest try first, so a month that keeps
-- failing cannot starve the rest). overage.paid_at / failed_at: Stripe's time
-- (ms) of the latest invoice.paid / invoice.payment_failed for that month's
-- overage invoice; payment_attempts counts the failures. Payment state only:
-- it never touches tier, status or grace. Forward only; no row changes.
ALTER TABLE usage ADD COLUMN retried_at INTEGER;
ALTER TABLE overage ADD COLUMN paid_at INTEGER;
ALTER TABLE overage ADD COLUMN failed_at INTEGER;
ALTER TABLE overage ADD COLUMN payment_attempts INTEGER NOT NULL DEFAULT 0;
