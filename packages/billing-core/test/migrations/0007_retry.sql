-- Retrying unapplied months (#2210, #2246). usage.retried_at: when the daily
-- cron last re-tried a closed month (oldest try first, so a month that keeps
-- failing cannot starve the rest). Closed months already stored without an
-- outcome are marked 'legacy' and never retried, so deploying does not bill
-- old reports. overage.paid_at / failed_at / voided_at: Stripe's time (ms) of
-- the latest invoice.paid, invoice.payment_failed and invoice.voided or
-- marked_uncollectible for that month's overage invoice; amount_due is the
-- failed invoice's own amount (cents, tax and discounts included);
-- payment_attempts counts the failures. Payment state only: it never touches
-- tier, status or grace. Forward only.
ALTER TABLE usage ADD COLUMN retried_at INTEGER;
UPDATE usage SET apply_outcome = 'legacy' WHERE apply_outcome IS NULL AND month < strftime('%Y-%m', 'now');
ALTER TABLE overage ADD COLUMN paid_at INTEGER;
ALTER TABLE overage ADD COLUMN failed_at INTEGER;
ALTER TABLE overage ADD COLUMN voided_at INTEGER;
ALTER TABLE overage ADD COLUMN amount_due INTEGER;
ALTER TABLE overage ADD COLUMN payment_attempts INTEGER NOT NULL DEFAULT 0;
