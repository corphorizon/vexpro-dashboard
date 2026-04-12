-- Migration 010: Create commercial_negotiations table
CREATE TABLE IF NOT EXISTS commercial_negotiations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  profile_id uuid NOT NULL REFERENCES commercial_profiles(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  description text,
  status varchar(50) DEFAULT 'active' CHECK (status IN ('active', 'closed', 'pending')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_negotiations_profile ON commercial_negotiations(profile_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_company ON commercial_negotiations(company_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_status ON commercial_negotiations(status);

-- RLS (disabled — we use service-role admin client)
ALTER TABLE commercial_negotiations ENABLE ROW LEVEL SECURITY;
