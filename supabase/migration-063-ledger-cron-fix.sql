-- Migración 063 — Arreglo del asiento automático del libro por canal
-- (APLICADA a producción el 2026-08-06, tras la auditoría A1.)
--
-- 1) EL CRON NUNCA PUDO ESCRIBIR: el upsert usaba ON CONFLICT contra el
--    índice único PARCIAL (where source='api') y PostgREST no emite el
--    predicado → 42P10 en cada corrida, silencioso porque el error viajaba
--    dentro de un HTTP 200. Esta RPC reemplaza el DÍA COMPLETO (delete de las
--    líneas 'api' + insert) en una transacción: idempotente de verdad y sin
--    líneas huérfanas cuando una re-corrida produce menos líneas.
--
-- 2) SNAPSHOT PISADO: al fijarse la wallet 1705 (15:42) se re-corrió el
--    snapshot y la fila del 2026-08-06 (= cierre del 05) quedó con una
--    lectura intradía de 3 wallets. Se restauró el cierre real (573.884,41,
--    verificado a las 11:11), se eliminó la fila de la 1705 (no estaba fijada
--    el 05) y su saldo preexistente (38.397,58) se asentó como línea manual
--    de alta el 06 — sin eso, el ajuste de conciliación lo absorbería como
--    movimiento fantasma de ~+37K.
--
-- En el código: channel-ledger-sync usa esta RPC, aborta si |ajuste| supera
-- MAX_ADJUSTMENT por canal, el snapshot pasa a ser inmutable intradía
-- (ignoreDuplicates) y el cron devuelve 500 + Sentry si el libro falla.

create or replace function public.replace_channel_ledger_day(
  p_company_id  uuid,
  p_channel_key text,
  p_entry_date  date,
  p_lines       jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.channel_ledger_entries
   where company_id = p_company_id
     and channel_key = p_channel_key
     and entry_date = p_entry_date
     and source = 'api'
     and kind <> 'opening';

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    insert into public.channel_ledger_entries
      (company_id, channel_key, entry_date, kind, source, concept, category, amount, notes)
    select
      p_company_id, p_channel_key, p_entry_date,
      l->>'kind', 'api', l->>'concept', l->>'category',
      (l->>'amount')::numeric,
      nullif(l->>'notes', '')
    from jsonb_array_elements(p_lines) as l;
  end if;
end;
$$;

revoke all on function public.replace_channel_ledger_day(uuid, text, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_channel_ledger_day(uuid, text, date, jsonb) to service_role;

-- Corrección de datos puntual (ya ejecutada; se deja como registro):
--   channel_balances 2026-08-06 'coinsbuy'      → 573884.41
--   channel_balances 2026-08-06 'coinsbuy:1079' → 163884.41
--   channel_balances 2026-08-06 'coinsbuy:1705' → eliminada
--   channel_ledger_entries: línea manual 'Alta de wallet en el agregado —
--   Egresos Vex (1705)' in 38397.58 con fecha 2026-08-06.
