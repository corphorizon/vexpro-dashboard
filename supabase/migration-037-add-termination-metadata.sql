-- Metadata de despidos sobre commercial_profiles:
--   termination_reason   → texto libre con los detalles
--   termination_category → categoría controlada por CHECK
--   terminated_by        → auth.users.id de quien ejecutó el despido
--
-- El registro NO se borra: permite seguir cargando comisiones post-despido.
ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS termination_reason text NULL,
  ADD COLUMN IF NOT EXISTS termination_category text NULL,
  ADD COLUMN IF NOT EXISTS terminated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commercial_profiles_termination_category_check'
  ) THEN
    ALTER TABLE commercial_profiles
      ADD CONSTRAINT commercial_profiles_termination_category_check
      CHECK (
        termination_category IS NULL
        OR termination_category IN ('performance', 'misconduct', 'voluntary', 'restructuring', 'other')
      );
  END IF;
END $$;
