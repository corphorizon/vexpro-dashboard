-- Migration 011: Allow free-text roles in commercial_profiles
-- Drop the restrictive CHECK constraint and replace with a more flexible one

ALTER TABLE commercial_profiles DROP CONSTRAINT IF EXISTS commercial_profiles_role_check;

-- No constraint — role is now free text (e.g. 'bdm', 'head', 'closer', 'setter', 'trader', etc.)
-- The original roles ('sales_manager', 'head', 'bdm') still work, plus any new ones.
