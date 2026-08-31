-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 112 — De cuándo es el saldo de cada canal
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Auditoría de finanzas,
-- ítem 23.
--
-- POR QUÉ
-- En /balances, `otros` ($14.493, cuyo ÚNICO asiento es del 2026-08-05) se
-- pintaba exactamente igual que Coinsbuy en vivo. El saldo de una ubicación
-- manual no envejece solo: si nadie carga un asiento, el número se queda
-- quieto y sigue pareciendo el de hoy. Verificado en producción el 2026-08-31
-- (Vex Pro): último asiento por canal → otros 05/08, custom_98bb… 19/08,
-- coinsbuy 20/08, fairpay 24/08, wallet_externa 29/08, paypros 30/08,
-- unipayment 30/08.
--
-- La pantalla ya sabe de cuándo es un SNAPSHOT (`channel_balances_as_of`
-- devuelve la fila entera, con `snapshot_date`). Lo que no tenía forma de
-- saber es de cuándo es el saldo del LIBRO — que es justamente la fuente que
-- manda para todas las ubicaciones manuales.
--
-- POR QUÉ UNA FUNCIÓN NUEVA Y NO AMPLIAR get_channel_ledger_balances
-- Cambiarle el `returns table` a una función existente obliga a DROP + CREATE,
-- y un DROP FUNCTION reabre los grants (es exactamente lo que las migraciones
-- 077/078 vinieron a cerrar, y `scripts/check-rpc-grants.ts` es «la defensa
-- real» contra eso). Una función nueva al lado no toca la que ya anda.
--
-- SECURITY INVOKER a propósito, igual que get_channel_ledger_balances: con RLS
-- activa la aislación por empresa la da la política. Un DEFINER acá sería una
-- fuga multitenant (cualquiera podría pasar el id de otra empresa).
--
-- Idempotente: create or replace + revoke/grant explícitos.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_channel_ledger_last_entry(
  p_company_id uuid,
  p_asof       date
)
returns table (channel_key text, last_entry_date date)
language sql
stable
security invoker
set search_path = public
as $$
  select e.channel_key, max(e.entry_date)
  from public.channel_ledger_entries e
  where e.company_id = p_company_id
    and e.entry_date <= p_asof
  group by e.channel_key;
$$;

revoke all on function public.get_channel_ledger_last_entry(uuid, date) from public, anon;
grant execute on function public.get_channel_ledger_last_entry(uuid, date) to authenticated, service_role;
