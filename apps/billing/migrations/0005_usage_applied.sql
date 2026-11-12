-- Per-creator monthly billing (#2123): what a closed month's usage report set
-- on the install's monthly Team or Business subscription. A report is stored
-- first; these record the quantity applied and when (NULL until it is), and
-- the outcome of the last try (applied, unchanged, a skip reason, or failed,
-- which the next report or retry tries again). Forward only; no row changes.
ALTER TABLE usage ADD COLUMN applied_quantity INTEGER;
ALTER TABLE usage ADD COLUMN applied_at INTEGER;
ALTER TABLE usage ADD COLUMN apply_outcome TEXT;
