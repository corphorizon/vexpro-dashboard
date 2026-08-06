-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 060 — Referencia y comprobante en egresos
--
-- Los egresos solo tenían concepto y monto: para saber CON QUÉ se pagó había
-- que buscar la transacción por fuera. Las órdenes de pago ya resolvían esto
-- (referencia en texto + archivo adjunto), así que se replica el mismo par.
--
-- Y cuando el egreso nace de una orden pagada, hereda automáticamente la
-- referencia y el comprobante de ESA orden: es la misma plata, y volver a
-- cargarlos a mano era pedir que se desincronizaran.
--
-- POR QUÉ SE GUARDA EL BUCKET, NO SOLO EL PATH
-- El comprobante de una orden vive en `payment-proofs`; el que se sube
-- directo a un egreso vive en `expense-attachments`. Si solo guardáramos el
-- path, un egreso heredado apuntaría al bucket equivocado y el archivo daría
-- 404. Guardar el bucket permite además NO duplicar el archivo: el egreso
-- referencia el comprobante original de la orden.
--
-- OJO — TRAMPA CONOCIDA (ver migración 058):
-- `replace_period_expenses` BORRA e INSERTA todo el período. Cualquier
-- columna nueva que no viaje en el payload jsonb se pierde en silencio en el
-- próximo guardado del mes. Por eso la RPC se actualiza acá mismo, en la
-- misma migración que agrega las columnas.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.expenses
  add column if not exists reference text,
  add column if not exists attachment_bucket text,
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size int,
  add column if not exists attachment_uploaded_at timestamptz;

comment on column public.expenses.reference is
  'Hash de transacción, número de operación bancaria o link al comprobante. Heredado de la orden de pago cuando el egreso nace de una.';
comment on column public.expenses.attachment_bucket is
  'Bucket de Storage donde vive el adjunto: expense-attachments (subido al egreso) o payment-proofs (heredado de una orden).';

-- ── RPC actualizada: las columnas nuevas viajan en el payload ────────────────
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

  delete from public.expenses
  where company_id = p_company_id and period_id = p_period_id;

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
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx);
  end if;
end;
$$;

-- ── Backfill: los egresos que ya nacieron de una orden heredan su traza ──────
-- Hay 8 egresos vinculados por payment_order_id (migración 058) que se
-- crearon antes de que existieran estas columnas.
update public.expenses e
   set reference              = po.payment_reference,
       attachment_bucket      = case when po.payment_proof_path is not null then 'payment-proofs' end,
       attachment_path        = po.payment_proof_path,
       attachment_name        = po.payment_proof_name,
       attachment_mime        = po.payment_proof_mime,
       attachment_size        = po.payment_proof_size,
       attachment_uploaded_at = po.payment_proof_uploaded_at
  from public.payment_orders po
 where e.payment_order_id = po.id
   and e.reference is null
   and (po.payment_reference is not null or po.payment_proof_path is not null);
