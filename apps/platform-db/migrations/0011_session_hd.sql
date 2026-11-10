-- Sign-up page (signup.<app>): a self-serve session records the Google
-- Workspace domain (`hd`) the ID token carried, NULL for a personal account,
-- so the self-serve create policy (4.2: a Workspace account is required) reads
-- the verified claim and never the email domain. Admin sessions leave it NULL.
-- Additive only.
ALTER TABLE sessions ADD COLUMN hd TEXT;
