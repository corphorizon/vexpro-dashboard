-- Agrega termination_date a commercial_profiles.
-- Permite marcar comerciales como despedidos manteniendo el registro vivo
-- para poder seguir cargando net deposits negativos contra profile_id
-- en commercial_monthly_results.
ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS termination_date date NULL;

COMMENT ON COLUMN commercial_profiles.termination_date IS
  'Fecha de despido. NULL = no despedido. Si se setea junto con status=inactive, la UI muestra el perfil como "Despedido" (badge gris). El registro NO se borra para permitir cargar comisiones negativas post-despido.';
