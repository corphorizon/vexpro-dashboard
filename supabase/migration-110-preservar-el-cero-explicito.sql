-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 110 — «Cargado y verificado en cero» deja de ser lo mismo que
--                 «nunca cargado» (depósitos y retiros)
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Auditoría de finanzas,
-- ítem 21. Es §1.3 del manual del repo aplicado a las dos tablas que faltaban:
-- *`null` = no lo sabemos · `0` = es cero. Mezclarlos rompe en silencio.*
--
-- EL BUG
-- ───────────────────────────────────────────────────────────────────────────
-- `replace_period_deposits` y `replace_period_withdrawals` BORRAN el período
-- entero y re-insertan desde el payload con `where … amount > 0` (migración
-- 049). O sea: poner un canal en cero y guardar **borra la fila**. Después no
-- hay forma de distinguir «lo miré, no hubo movimiento» de «nunca lo cargué»:
-- las dos cosas son la ausencia de fila, y río abajo las dos se leen 0.
--
-- Eso es lo que dejó pasar el descuadre de Feb-26: la categoría `prop_firm` de
-- ese mes no tiene fila, el CRM tiene $2.373,37 de retiros de prop firm, y
-- como «no cargado» se lee igual que «cero», nadie lo notó hasta que la plata
-- ya estaba repartida de más. (El aviso que lo habría atrapado es el chequeo
-- de deriva del checklist de cierre, migración 111 — este arreglo es el otro
-- lado: que el dato se pueda cargar en cero y quede.)
--
-- LA DECISIÓN — server-authoritative, igual que la migración 079
-- ───────────────────────────────────────────────────────────────────────────
-- No alcanza con sacar el `> 0`: el cliente NO manda sólo lo que la persona
-- tocó. `/upload` hidrata SIEMPRE la lista fija de canales/categorías con
-- `amount: match?.amount || 0` (upload/page.tsx → loadDepositsForPeriod /
-- loadWithdrawalsForPeriod) y las re-envía enteras. Quitar el filtro haría que
-- el primer guardado de cualquier mes creara una fila en 0 para TODOS los
-- canales — o sea, convertiría «nunca cargado» en «cargado en cero» para todo
-- el sistema. El mismo bug, dado vuelta.
--
-- Regla adoptada: **la RPC nunca CREA un 0, pero nunca DESTRUYE uno que ya
-- existía.**
--   · Llega 0 y la clave YA tenía fila → se conserva, ahora con 0. Es un
--     dato: alguien puso ese número a propósito.
--   · Llega 0 y la clave nunca tuvo fila → no se inserta. Es el default del
--     input, no una afirmación de nadie.
--   · Llega > 0 → se inserta, como siempre.
--
-- Se descartó pedirle al cliente que mande un flag «tocado»: la plata no puede
-- depender de la corrección del navegador (migración 079, tras perder $1.700).
-- Se descartó también un `null` en `amount`: la columna es `not null` en
-- producción y aflojarla obliga a revisar las ~20 lecturas de estas tablas.
--
-- LÍMITE CONOCIDO, dicho en voz alta: la PRIMERA vez que alguien escribe 0 en
-- un canal que nunca tuvo fila, sigue sin guardarse. Es indistinguible del
-- default del formulario (que también es 0), así que guardarlo sería inventar
-- una intención. Para dejar constancia de un cero inicial hay que cargar el
-- valor real y después bajarlo a 0 — o registrarlo en el libro del canal.
--
-- DATOS EXISTENTES EN PRODUCCIÓN (verificado el 2026-08-31, solo lectura):
-- 5 filas de `deposits` y 8 de `withdrawals` con amount = 0, todas de Vex Pro
-- y todas en períodos CERRADOS (Oct-25 … Feb-26). Este cambio no las toca: el
-- trigger `trg_guard_closed_period` (migración 061) ya rechaza cualquier
-- escritura sobre ellas, y si alguna vez se reabre ese mes, ahora SOBREVIVEN
-- al guardado en vez de borrarse.
--
-- SEGURIDAD — sin cambios: se conserva el guard `auth_can_edit` bajo
-- `authenticated` (bypass sólo para service_role, migración 049) y los grants
-- de la 044.
--
-- Idempotente: create or replace.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.replace_period_deposits(p_company_id uuid, p_period_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_existing text[];
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar depósitos de esta empresa';
  end if;

  -- Qué canales YA tenían fila. Se lee ANTES del delete: después no hay a
  -- quién preguntarle si ese 0 es un dato o el default del formulario.
  select coalesce(array_agg(distinct channel), '{}'::text[])
    into v_existing
  from public.deposits
  where company_id = p_company_id and period_id = p_period_id;

  delete from public.deposits where company_id = p_company_id and period_id = p_period_id;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.deposits (company_id, period_id, channel, amount)
    select p_company_id, p_period_id, r->>'channel', coalesce((r->>'amount')::numeric, 0)
    from jsonb_array_elements(p_rows) as r
    where coalesce((r->>'amount')::numeric, 0) > 0
       or (r->>'channel') = any(v_existing);
  end if;
end; $$;

create or replace function public.replace_period_withdrawals(p_company_id uuid, p_period_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_existing text[];
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar retiros de esta empresa';
  end if;

  -- Clave = `category`, que es la del UNIQUE de la migración 065
  -- (withdrawals_company_period_category_unique): una fila por categoría.
  select coalesce(array_agg(distinct category), '{}'::text[])
    into v_existing
  from public.withdrawals
  where company_id = p_company_id and period_id = p_period_id;

  delete from public.withdrawals where company_id = p_company_id and period_id = p_period_id;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.withdrawals (company_id, period_id, category, amount, description)
    select p_company_id, p_period_id, r->>'category', coalesce((r->>'amount')::numeric, 0),
           nullif(r->>'description','')
    from jsonb_array_elements(p_rows) as r
    where coalesce((r->>'amount')::numeric, 0) > 0
       or (r->>'category') = any(v_existing);
  end if;
end; $$;

-- Grants idénticos a la migración 044 (create or replace los conserva; se
-- repiten para que aplicar este archivo solo deje el estado correcto).
revoke all on function public.replace_period_deposits(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_deposits(uuid, uuid, jsonb) to authenticated;
revoke all on function public.replace_period_withdrawals(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_withdrawals(uuid, uuid, jsonb) to authenticated;
