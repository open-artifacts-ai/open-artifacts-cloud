-- A subscription's schedule (#2138, #2135), recorded by customer.subscription.
-- created/updated under the same ordering guard as the rest of its state, and
-- reported to installs; none of it moves tier, status or grace. Forward only.
-- cancels_at: the date (ms) a scheduled cancel (cancel_at_period_end, or
--   cancel_at) takes effect; NULL when none or it was resumed.
-- renews_at: the end (ms) of the current period, when the next charge is due;
--   NULL while a cancel is scheduled, and on a deleted subscription.
-- billing_interval: 'month' or 'year', the subscription item's price interval.
ALTER TABLE tiers ADD COLUMN cancels_at INTEGER;
ALTER TABLE tiers ADD COLUMN renews_at INTEGER;
ALTER TABLE tiers ADD COLUMN billing_interval TEXT;
