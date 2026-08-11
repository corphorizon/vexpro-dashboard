-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 079 — Los egresos de órdenes de pago dejan de perderse en /upload
--
-- EL BUG (confirmado en PROD: VexPro perdió $1.700 de egresos en agosto 2026)
-- ───────────────────────────────────────────────────────────────────────────
-- Marcar una orden de pago como PAGADA crea, server-side, un egreso en la tabla
-- `expenses` con `payment_order_id` seteado (createExpenseForPaidOrder). Ese
-- egreso vive en el mismo período que los egresos manuales del mes.
--
-- Guardar egresos desde /upload llama a `replace_period_expenses`, que BORRA
-- TODOS los egresos del período y los RE-INSERTA desde el estado de React del
-- que guarda. Si una OP se pagó desde OTRA pestaña / otro usuario / otro
-- dispositivo DESPUÉS de que esa persona cargó /upload, el egreso de la OP NO
-- está en su estado local → el DELETE lo borra y el INSERT no lo repone.
--
-- Peor aún: `payment_orders.expense_id` apunta al egreso con
-- `on delete set null`. Al borrarse el egreso, la orden queda con
-- expense_id = NULL, y ese puntero era HOY el ÚNICO candado anti-duplicado
-- (transition/route.ts sólo crea el egreso si `!result.expense_id`). Resultado:
-- se pierde el egreso Y se abre la puerta a que una re-marca "pagada" genere
-- un duplicado.
--
-- LA CORRECCIÓN — parte 1: la RPC nunca más toca los egresos de OP
-- ───────────────────────────────────────────────────────────────────────────
-- Se redefine `replace_period_expenses` para que el DELETE y el INSERT operen
-- ÚNICAMENTE sobre las filas MANUALES (`payment_order_id IS NULL`). Las filas
-- generadas por órdenes de pago quedan bajo dominio EXCLUSIVO del módulo de
-- tesorería (createExpenseForPaidOrder / transition): /upload no puede borrarlas
-- ni duplicarlas, pase lo que pase.
--
-- ENFOQUE ELEGIDO (y por qué, ver también reporte):
--   El cliente HOY carga en su estado TODOS los egresos del período —incluidas
--   las filas de OP— y las RE-ENVÍA en el payload (upload/page.tsx →
--   loadExpensesForPeriod → upsertExpenses). Por eso NO alcanza con excluir del
--   DELETE: si el DELETE preserva las filas de OP pero el INSERT las vuelve a
--   insertar desde el payload, se DUPLICAN en cada guardado del mes. Catastrófico.
--
--   Se descartó el enfoque "que el cliente NO mande las filas de OP y la función
--   sólo reemplace las manuales": depende de que el cliente se comporte bien. Un
--   cliente viejo en caché, un bug de front o un payload forjado volverían a
--   duplicar/borrar. La plata no puede depender de la corrección del navegador.
--
--   Enfoque adoptado (server-authoritative, simétrico): la RPC filtra
--   `payment_order_id IS NULL` en AMBOS lados —DELETE e INSERT—. Así es
--   IDEMPOTENTE sin importar qué mande el cliente: las filas de OP que lleguen
--   en el payload se ignoran en el INSERT (no se duplican) y jamás se borran en
--   el DELETE. No hace falta tocar el cliente para que sea correcto.
--
--   Efecto colateral asumido: editar monto/pagado/pendiente de un egreso de OP
--   desde /upload deja de persistir (la fila conserva sus valores de DB). Es el
--   comportamiento correcto: ese egreso ESPEJA a la orden y editarlo suelto en
--   /upload lo desincronizaba. La fuente de verdad es la orden de pago.
--
-- LA CORRECCIÓN — parte 2: candado anti-duplicado que no depende del puntero
-- ───────────────────────────────────────────────────────────────────────────
-- Índice UNIQUE parcial sobre `expenses(payment_order_id) WHERE payment_order_id
-- IS NOT NULL`. Garantiza a nivel DB que una orden no pueda generar dos egresos
-- AUNQUE se pierda `payment_orders.expense_id`. Reemplaza al índice NO único
-- `idx_expenses_payment_order` de la migración 058 (mismo predicado).
--
-- TRIGGER DE PERÍODO CERRADO — se respeta igual: `trg_guard_closed_period`
-- (migración 061) es un trigger BEFORE INSERT/UPDATE/DELETE FOR EACH ROW sobre
-- `expenses`; es independiente del cuerpo de la RPC y sigue disparando fila por
-- fila. Reducir el conjunto de filas borradas no lo altera.
--
-- SEGURIDAD — sin cambios: se conserva el guard interno auth_can_edit bajo
-- authenticated (bypass sólo para service_role) y los grants revoke/grant
-- idénticos a la migración 060.
--
-- Idempotente: create or replace + índices con if [not] exists.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. RPC: DELETE e INSERT sólo sobre filas manuales (payment_order_id IS NULL)
create or replace function public.replace_period_expenses(
  p_company_id uuid,
  p_period_id  uuid,
  p_rows       jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar egresos de esta empresa';
  end if;

  -- Sólo se borran las filas MANUALES. Los egresos generados por órdenes de
  -- pago (payment_order_id IS NOT NULL) son intocables desde acá: los administra
  -- exclusivamente el módulo de tesorería. Éste es el fix del vaciado de $1.700.
  delete from public.expenses
  where company_id = p_company_id
    and period_id = p_period_id
    and payment_order_id is null;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.expenses
      (company_id, period_id, concept, amount, paid, pending, is_fixed, category,
       expense_date, payment_order_id, reference,
       attachment_bucket, attachment_path, attachment_name, attachment_mime,
       attachment_size, attachment_uploaded_at,
       sort_order, created_at, updated_at)
    select
      p_company_id, p_period_id,
      r->>'concept',
      coalesce((r->>'amount')::numeric, 0),
      coalesce((r->>'paid')::numeric, 0),
      coalesce((r->>'pending')::numeric, 0),
      coalesce((r->>'is_fixed')::boolean, false),
      nullif(r->>'category', ''),
      nullif(r->>'expense_date', '')::date,
      nullif(r->>'payment_order_id', '')::uuid,
      nullif(r->>'reference', ''),
      nullif(r->>'attachment_bucket', ''),
      nullif(r->>'attachment_path', ''),
      nullif(r->>'attachment_name', ''),
      nullif(r->>'attachment_mime', ''),
      nullif(r->>'attachment_size', '')::int,
      nullif(r->>'attachment_uploaded_at', '')::timestamptz,
      idx::int, now(), now()
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx)
    -- Simétrico al DELETE: las filas de OP que el cliente re-mande en el payload
    -- se ignoran en el INSERT. Sin esto se DUPLICARÍAN (no se borraron arriba).
    where nullif(r->>'payment_order_id', '') is null;
  end if;
end;
$$;

revoke all on function public.replace_period_expenses(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_expenses(uuid, uuid, jsonb) to authenticated;

-- ── 2. Candado anti-duplicado: índice UNIQUE parcial sobre payment_order_id ───
-- Antes de crear el índice único: si el bug ya dejó DOS egresos con el mismo
-- payment_order_id, la creación fallaría con un error genérico. Este bloque lo
-- detecta y aborta con un mensaje accionable (lista los ids duplicados) para
-- que se resuelvan a mano ANTES de aplicar el índice. No muta plata en silencio.
do $$
declare
  v_dups text;
begin
  select string_agg(payment_order_id::text, ', ')
    into v_dups
  from (
    select payment_order_id
      from public.expenses
     where payment_order_id is not null
     group by payment_order_id
    having count(*) > 1
  ) d;

  if v_dups is not null then
    raise exception
      'No se puede crear el índice único: existen egresos DUPLICADOS para las órdenes de pago [%]. Resolvé los duplicados (dejá un solo egreso por orden) y reaplicá esta migración.', v_dups;
  end if;
end;
$$;

-- El índice único parcial reemplaza al no-único de la migración 058 (mismo
-- predicado, así que aquél queda redundante).
drop index if exists public.idx_expenses_payment_order;

create unique index if not exists idx_expenses_payment_order_unique
  on public.expenses(payment_order_id)
  where payment_order_id is not null;

comment on index public.idx_expenses_payment_order_unique is
  'Candado anti-duplicado: una orden de pago no puede generar dos egresos, aunque se pierda el puntero payment_orders.expense_id (migración 079).';
