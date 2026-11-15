-- Per-member billing (#2580): the member count each install last reported on
-- POST /seats, one row per install. ts is the instance's report time; an
-- older (smaller) ts never overwrites a newer one. applied_quantity /
-- applied_at / apply_outcome record what was last written to Stripe (or why
-- nothing was). seat_failed_at / seat_amount_due / seat_failures record a
-- mid-term yearly seat invoice whose payment failed; the plan never moves.
-- Forward only; no existing row changes.
CREATE TABLE seats (
  install_id TEXT PRIMARY KEY,
  members INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  applied_quantity INTEGER,
  applied_at INTEGER,
  apply_outcome TEXT,
  seat_failed_at INTEGER,
  seat_amount_due INTEGER,
  seat_failures INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
