-- Migración 065 — Una fila por categoría de retiro por período.
-- (APLICADA a producción el 2026-08-06 — auditoría C5.)
--
-- Sin este UNIQUE, dos filas prop_firm en el mismo período hacían que tres
-- pantallas mostraran tres "Monto a Distribuir" distintos: getPeriodSummary
-- tomaba la primera (.find), computeSaldoChain la última (Map.set) y el
-- consolidado las sumaba. Verificado: no había duplicados, el índice entró
-- sin tocar datos. El cliente además consolida por categoría antes de enviar
-- (upsertWithdrawals en src/lib/supabase/mutations.ts).
create unique index if not exists withdrawals_company_period_category_unique
  on public.withdrawals (company_id, period_id, category);
