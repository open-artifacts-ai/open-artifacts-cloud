-- Per-member billing (#2580): the member count each install last reported on
-- POST /seats, one row per install. ts is the instance's report time; an
-- older (smaller) ts never overwrites a newer one. applied_quantity /
-- applied_at / apply_outcome record what was last written to Stripe (or why
-- nothing was). per_member is 1 for a subscription created at or after
-- PER_MEMBER_FROM, 0 for an older one (it keeps /usage counting), NULL until
-- known. The seat_* columns track a mid-term yearly seat invoice:
-- seat_prev_quantity is the quantity before the last invoiced increase,
-- seat_failed_at / seat_paid_at / seat_closed_at the payment events (closed =
-- voided or uncollectible), seat_rollback_at when the increase was undone.
-- Forward only; no existing row changes.
CREATE TABLE seats (
  install_id TEXT PRIMARY KEY,
  members INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  applied_quantity INTEGER,
  applied_at INTEGER,
  apply_outcome TEXT,
  per_member INTEGER,
  seat_prev_quantity INTEGER,
  seat_failed_at INTEGER,
  seat_paid_at INTEGER,
  seat_closed_at INTEGER,
  seat_rollback_at INTEGER,
  seat_amount_due INTEGER,
  seat_failures INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
