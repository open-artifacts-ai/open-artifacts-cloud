-- The Stripe test clock a staging install's customer is attached to, set only
-- for an install listed in STAGING_TEST_CLOCK_INSTALLS (staging, test key).
-- NULL for every other install.
ALTER TABLE tiers ADD COLUMN stripe_test_clock_id TEXT;
