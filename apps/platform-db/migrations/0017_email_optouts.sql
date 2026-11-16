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

-- A redemption past its minting install's daily cap is still stored, but
-- scoped to that install: check honours it only for that install until an
-- operator widens the batch into email_optouts. Two installs may each hold
-- their own row for one address.
CREATE TABLE IF NOT EXISTS email_optouts_install (
  addr_hash TEXT NOT NULL,
  install_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (addr_hash, install_id)
);
