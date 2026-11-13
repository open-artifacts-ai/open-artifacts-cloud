-- Business "Contact us" (open-artifacts#2404): every request recorded, whether
-- or not the operator email went out. Written by the sign-up Worker's public
-- POST /api/v1/contact (no session); read and triaged by admins. email is
-- lowercased, instance_host is as given and unverified, needs is a JSON array
-- of group_sync, sharing_controls, audit_log, custom_domain, other. No foreign
-- key, and nothing else references the table. Additive; no backfill.
CREATE TABLE business_requests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  team_size TEXT NOT NULL
    CHECK (team_size IN ('1-10', '11-50', '51-200', '200+')),
  needs TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  source TEXT NOT NULL CHECK (source IN ('landing', 'dashboard')),
  instance_host TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'closed')),
  status_changed_at INTEGER,
  status_changed_by TEXT
);
CREATE INDEX business_requests_created ON business_requests (created_at);
