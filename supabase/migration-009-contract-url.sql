-- Migration 009: Add contract_url to commercial_profiles
-- Stores the URL of the signed contract uploaded to Supabase Storage

ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS contract_url TEXT;

-- Create storage bucket for contracts (run in Supabase Dashboard > Storage)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('contracts', 'contracts', false);
