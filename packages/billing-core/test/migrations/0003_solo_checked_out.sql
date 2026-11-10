-- 1 once the install has a paid Checkout (a card is on file), set by the
-- checkout webhook when it adopts the subscription. Such a row keeps
-- solo_trial_ends_at (the Checkout kept the free days), so the trial-ending
-- reminder list skips it: the no-card copy would be false for it.
ALTER TABLE tiers ADD COLUMN solo_checked_out INTEGER;
