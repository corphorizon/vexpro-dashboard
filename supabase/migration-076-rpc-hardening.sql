-- Migración 076 — Endurecimiento de RPCs expuestas por REST
--
-- El linter de Supabase (2026-08-10) detectó funciones SECURITY DEFINER
-- ejecutables por cualquier usuario autenticado vía /rest/v1/rpc/*. Auditadas
-- una por una, SEIS no tenían guard interno y tomaban company_id por
-- parámetro — o sea que un usuario autenticado de CUALQUIER empresa podía:
--
--   · close_period / reopen_period ....... cerrar o reabrir períodos ajenos
--                                          (con actor falsificable por parámetro)
--   · get_period_totals_by_month ......... LEER totales financieros ajenos
--   · replace_channel_ledger_day ......... escribir el libro de canales ajeno
--   · split_liquidity_movement ........... partir movimientos de liquidez ajenos
--   · next_payment_order_number .......... quemar el correlativo de órdenes ajeno
--
-- Las seis se llaman ÚNICAMENTE desde rutas del servidor con service role
-- (verificado con grep: data/route.ts, period-totals/route.ts,
-- channel-ledger-sync.ts, liquidity-reconcile/route.ts,
-- payment-orders/server.ts). Ningún navegador las invoca, así que el fix
-- correcto no es un guard interno sino cerrar la puerta REST: se revoca
-- EXECUTE a anon y authenticated. El service role no pasa por estos grants.
--
-- Las RPCs que SÍ se llaman desde el navegador (replace_period_expenses/
-- deposits/withdrawals, materialize_fixed_expenses) ya tienen guard
-- auth_can_edit interno y quedan como están. Los helpers de auth
-- (is_superadmin, auth_can_edit...) conservan EXECUTE para authenticated
-- porque las policies de RLS los evalúan con el rol del consultante.
--
-- Además: dos triggers sin search_path fijo (riesgo de suplantación de
-- schema para un atacante con CREATE en otro schema).

revoke execute on function public.close_period(uuid, uuid, uuid, text) from anon, authenticated;
revoke execute on function public.reopen_period(uuid, uuid, uuid, text, text) from anon, authenticated;
revoke execute on function public.get_period_totals_by_month(uuid, timestamptz, timestamptz) from anon, authenticated;
revoke execute on function public.replace_channel_ledger_day(uuid, text, date, jsonb) from anon, authenticated;
revoke execute on function public.split_liquidity_movement(uuid, uuid, jsonb) from anon, authenticated;
revoke execute on function public.next_payment_order_number(uuid) from anon, authenticated;

alter function public.payment_orders_guard() set search_path = public;
alter function public.channel_ledger_touch() set search_path = public;
