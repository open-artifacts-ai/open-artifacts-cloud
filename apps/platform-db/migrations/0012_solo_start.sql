-- Self-serve Solo start (ProvisionInstall's solo_start step): the local
-- signal the scheduler's solo_start_missing alert reads, so it never calls
-- billing. solo_started_at is set once billing's soloStart answered ok;
-- solo_skipped_at is set when the provisioner has no BILLING binding (prod
-- until billing ships there), so those rows never alert. A ready self-serve
-- signup with both NULL, older than 30 minutes, is the alert.
-- Rows that were already ready before this migration are marked skipped:
-- they never ran the step. Additive columns; the backfill touches only rows
-- with both columns NULL, so a re-run changes nothing.
ALTER TABLE signups ADD COLUMN solo_started_at INTEGER;
ALTER TABLE signups ADD COLUMN solo_skipped_at INTEGER;
UPDATE signups SET solo_skipped_at = updated_at
 WHERE solo_started_at IS NULL AND solo_skipped_at IS NULL;
