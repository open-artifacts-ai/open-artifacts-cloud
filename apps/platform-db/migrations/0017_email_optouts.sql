-- Hosted-wide email opt-out list (open-artifacts#2652). addr_hash is h2 =
-- HMAC-SHA256(OPTOUT_STORE_KEY, h1), where h1 is the install's keyed hash of
-- the address: the platform never receives or stores an address or an h1.
-- No foreign key. Additive.
CREATE TABLE IF NOT EXISTS email_optouts (
  addr_hash TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('recipient', 'bounce', 'complaint')),
  first_install TEXT,
  created_at INTEGER NOT NULL
);
