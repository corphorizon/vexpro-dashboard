-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 086 — Hasta 5 comprobantes por orden de pago
--
-- QUÉ PIDIÓ KEVIN
-- "Al registrar el pago hoy solo se puede subir UN comprobante. Quiero hasta 5."
--
-- POR QUÉ UNA TABLA Y NO CINCO JUEGOS DE COLUMNAS
-- El comprobante vive hoy en CINCO columnas de payment_orders
-- (payment_proof_path/name/mime/size/uploaded_at). Eso codifica "un archivo por
-- orden" en el esquema: para llegar a cinco habría que repetir las cinco
-- columnas cinco veces (25 columnas), y toda consulta pasaría a ser un coalesce
-- de cinco ramas. Con una tabla hija el tope es una regla de negocio (una
-- constante en el código, MAX_PAYMENT_PROOFS) y no una decisión de DDL: si
-- mañana son 8, no hay migración.
--
-- LAS COLUMNAS VIEJAS NO SE BORRAN TODAVÍA
-- A propósito. Se quedan como LEGADO: si hay que hacer rollback del código, la
-- versión anterior sigue leyendo su comprobante en las columnas y no ve una
-- orden sin respaldo. Una migración posterior (087+) las elimina cuando todo el
-- código lea de payment_order_proofs y haya pasado una ventana prudente.
-- Mientras tanto, el contrato es: si la orden TIENE filas en
-- payment_order_proofs, esas mandan; las columnas quedan congeladas.
--
-- OJO — el otro adjunto: attachment_* (la factura/contrato que JUSTIFICA la
-- orden) NO se toca. Es otro archivo, otro bucket y otra semántica.
--
-- BACKFILL ESPERADO (medido contra producción el 2026-08-17, solo lectura)
--   · payment_orders totales ............................ 25
--   · con payment_proof_path not null ................... 1   ← filas a insertar
--   · desglose: Vex Pro 1 (una orden pagada)
--   · paths duplicados que romperían el UNIQUE .......... 0
--   · objetos en el bucket privado `payment-proofs` ..... 1   (sin huérfanos)
-- O sea: el INSERT ... SELECT tiene que dejar exactamente 1 fila en
-- payment_order_proofs. Hay 22 órdenes pagadas, pero solo una tiene comprobante
-- cargado: el archivo siempre fue opcional.
--
-- ⚠️ NO APLICAR AUTOMÁTICAMENTE. Revisar y aplicar a mano (Kevin).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. La tabla ─────────────────────────────────────────────────────────────

create table if not exists public.payment_order_proofs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  -- on delete cascade: borrar un borrador (única orden borrable) se lleva sus
  -- comprobantes. Los objetos del bucket los limpia el endpoint DELETE; acá lo
  -- que importa es no dejar filas colgando de una orden que ya no existe.
  payment_order_id  uuid not null references public.payment_orders(id) on delete cascade,
  -- PATH dentro del bucket PRIVADO `payment-proofs`, nunca una URL pública: la
  -- lectura pasa por /api/admin/payment-orders/[id]/proof, que valida sesión +
  -- empresa y emite una URL firmada de 10 minutos.
  storage_path      text not null,
  file_name         text,
  mime              text,
  size              integer,
  uploaded_at       timestamptz not null default now(),
  -- auth.users y NO platform_users/company_users: el superadmin de plataforma no
  -- tiene fila en company_users, así que un FK a esa tabla haría fallar el
  -- insert justo cuando opera "viendo como" un tenant (mismo criterio que las
  -- FK de autoría del resto del módulo). Nullable: la autoría fina es un extra,
  -- el sello de auditoría fuerte ya está en audit_logs.
  uploaded_by       uuid references auth.users(id) on delete set null,
  -- Orden de exhibición en la UI. No es la clave de nada: solo evita que la
  -- lista baile entre renders cuando dos archivos entran en el mismo segundo.
  sort_order        smallint not null default 0
);

-- Un mismo objeto del bucket no puede estar dos veces en la misma orden: sin
-- esto, un doble submit del formulario duplica la fila y el tope de 5 se
-- consume con archivos repetidos.
alter table public.payment_order_proofs
  drop constraint if exists payment_order_proofs_order_path_key;
alter table public.payment_order_proofs
  add constraint payment_order_proofs_order_path_key
  unique (payment_order_id, storage_path);

-- La consulta que corre siempre: "los comprobantes de esta orden, en orden".
create index if not exists payment_order_proofs_order_idx
  on public.payment_order_proofs (payment_order_id, sort_order, uploaded_at);

-- FK sin índice = seek secuencial en cada borrado de empresa (auditoría 045).
create index if not exists payment_order_proofs_company_idx
  on public.payment_order_proofs (company_id);

comment on table public.payment_order_proofs is
  'Comprobantes de pago de una orden (hasta 5, tope aplicado en el servidor por MAX_PAYMENT_PROOFS). '
  'Reemplaza a payment_orders.payment_proof_* — esas columnas quedan como legado hasta la migración que las elimine.';
comment on column public.payment_order_proofs.storage_path is
  'Path dentro del bucket PRIVADO payment-proofs. Nunca una URL: la lectura emite una URL firmada corta.';
comment on column public.payment_order_proofs.sort_order is
  'Orden de exhibición. Lo asigna el endpoint POST de forma incremental sobre los ya existentes.';

-- ── 2. Backfill de lo que ya está en producción ─────────────────────────────
-- Sin esto, la orden pagada de Vex Pro que YA tiene comprobante aparecería sin
-- respaldo apenas el código empiece a leer de la tabla nueva. El `on conflict
-- do nothing` hace la migración idempotente (se puede correr dos veces).

insert into public.payment_order_proofs
  (company_id, payment_order_id, storage_path, file_name, mime, size, uploaded_at, sort_order)
select po.company_id,
       po.id,
       po.payment_proof_path,
       po.payment_proof_name,
       po.payment_proof_mime,
       po.payment_proof_size,
       -- Órdenes muy viejas pueden tener el path cargado sin fecha: se cae a la
       -- fecha del pago y, en última instancia, a la de creación de la orden.
       coalesce(po.payment_proof_uploaded_at, po.paid_at, po.created_at, now()),
       0
  from public.payment_orders po
 where po.payment_proof_path is not null
on conflict (payment_order_id, storage_path) do nothing;

-- Las columnas legadas quedan documentadas como tales para que nadie las use
-- como fuente de verdad en un endpoint nuevo.
comment on column public.payment_orders.payment_proof_path is
  'LEGADO (migración 086): el comprobante vive ahora en payment_order_proofs. Se conserva para permitir rollback del código; una migración posterior la elimina.';
comment on column public.payment_orders.payment_proof_name is
  'LEGADO (migración 086) — ver payment_order_proofs.file_name.';
comment on column public.payment_orders.payment_proof_mime is
  'LEGADO (migración 086) — ver payment_order_proofs.mime.';
comment on column public.payment_orders.payment_proof_size is
  'LEGADO (migración 086) — ver payment_order_proofs.size.';
comment on column public.payment_orders.payment_proof_uploaded_at is
  'LEGADO (migración 086) — ver payment_order_proofs.uploaded_at.';

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
-- Mismo patrón que payment_orders (migración 054): LECTURA para los miembros de
-- la empresa, ESCRITURA solo por el service role desde los endpoints. No hay
-- policy de insert/update/delete a propósito: con RLS activa y sin policy, el
-- cliente del browser no puede escribir ni una fila, y el admin client
-- (service_role) saltea RLS por completo.
-- auth_company_ids() ya contempla al superadmin (migración 024), así que no
-- hace falta el is_superadmin() explícito.

alter table public.payment_order_proofs enable row level security;

drop policy if exists payment_order_proofs_select on public.payment_order_proofs;
create policy payment_order_proofs_select on public.payment_order_proofs
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

commit;

-- ── Verificación posterior (solo lectura) ───────────────────────────────────
--   select count(*) from public.payment_order_proofs;                      -- esperado: 1
--   select count(*) from public.payment_orders where payment_proof_path is not null; -- 1
--   -- ninguna orden con comprobante debe quedar sin fila en la tabla nueva:
--   select po.id, po.order_number
--     from public.payment_orders po
--     left join public.payment_order_proofs p on p.payment_order_id = po.id
--    where po.payment_proof_path is not null and p.id is null;             -- esperado: 0 filas
