-- #2138: a scheduled cancel (Stripe cancel_at_period_end, or cancel_at). The
-- date (ms) the subscription ends at; NULL when none is scheduled or it was
-- resumed. Recorded by customer.subscription.created/updated, cleared by a
-- resume or by deleted, under the same ordering guard as the rest of the
-- subscription's state. Reported to installs as cancelsAt; it never moves
-- tier, status or grace. Forward only.
ALTER TABLE tiers ADD COLUMN cancels_at INTEGER;
