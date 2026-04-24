-- Agrega flag pnl_special_mode a commercial_profiles.
-- Modo alternativo de cálculo PnL:
--   commission     = pnl × pnl_pct         (sin dividir entre 2)
--   real_payment   = commission − com_lotes
--   accumulated_out = 0                   (no lleva acumulado al siguiente mes)
-- El perfil aparece en una sección "PnL Especial" separada de la PnL normal.
ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS pnl_special_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN commercial_profiles.pnl_special_mode IS
  'Modo PnL Especial: cuando TRUE, commission = pnl × pct (sin dividir ni acumular). Los lotes SÍ se restan. Solo afecta cálculos nuevos; el histórico se recalcula solo si el admin presiona el botón explícito.';
