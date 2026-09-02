-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 127 — Hasta 10 documentos de respaldo por orden de pago
--
-- QUÉ PIDIÓ KEVIN (2026-09-02)
-- "Que las órdenes de pago dejen subir hasta 10 archivos."
--
-- QUÉ ARCHIVO ES ESTE
-- El documento de RESPALDO (attachment_*): la factura, el contrato o la
-- cotización que JUSTIFICA la orden y que se adjunta al emitirla. NO es el
-- comprobante de pago (payment_order_proofs, migración 086), que es la prueba
-- de que el pago se hizo. Son dos archivos, dos buckets y dos semánticas — y
-- desde esta migración, dos tablas hijas con la misma forma.
--
-- POR QUÉ UNA TABLA Y NO DIEZ JUEGOS DE COLUMNAS
-- Mismo argumento que la 086, que ya lo pagó: el respaldo vive hoy en CINCO
-- columnas de payment_orders (attachment_path/_name/_mime/_size/
-- _uploaded_at, migración 057). Eso codifica "un archivo por orden" en el
-- esquema: para llegar a diez habría que repetir las cinco columnas diez veces
-- (50 columnas) y toda consulta pasaría a ser un coalesce de diez ramas. Con
-- una tabla hija el tope es una regla de negocio (una constante del código,
-- MAX_PAYMENT_ATTACHMENTS) y no una decisión de DDL: si mañana son 15, no hay
-- migración.
--
-- POR QUÉ CALCADA DE payment_order_proofs
-- Porque son el mismo problema. Dos tablas de archivos de la misma orden con
-- columnas distintas ("path" acá, "storage_path" allá) es la receta para que
-- un endpoint nuevo lea la columna que no es. Misma forma, mismos índices,
-- misma RLS, mismo criterio de FK a auth.users.
--
-- LAS COLUMNAS VIEJAS NO SE BORRAN TODAVÍA
-- A propósito, y con el mismo contrato que la 086: quedan como LEGADO para que
-- un rollback del código siga viendo su adjunto. Si la orden TIENE filas en
-- payment_order_attachments, esas mandan; las columnas quedan congeladas. Una
-- migración posterior las elimina cuando haya pasado una ventana prudente.
--
-- MEDICIÓN CONTRA PRODUCCIÓN (solo lectura, 2026-09-02, proyecto smart-dashboard)
--   · payment_orders totales ............................. 53
--   · con attachment_path not null ....................... 8   ← filas a insertar
--   · desglose: Vex Pro 7, AP Markets 1, Horizon Global 0
--   · con attachment_path y sin attachment_uploaded_at .... 0  (el coalesce no
--     debería usarse nunca, pero se deja por las órdenes que se creen antes de
--     aplicar esto)
--   · paths duplicados que romperían el UNIQUE ............ 0
--   · órdenes ANULADAS con adjunto ....................... 0
--   · to_regclass('public.payment_order_attachments') ..... null (no existe)
--   · payment_order_proofs (referencia) .................. 6 filas
-- O sea: el INSERT ... SELECT tiene que dejar exactamente 8 filas.
--
-- LO QUE SE DESCARTÓ
--   · Un array de jsonb en payment_orders: no hay FK, no hay unique, no hay
--     índice por archivo y el borrado de UNO obliga a reescribir la fila entera
--     de la orden — justo la fila que el trigger payment_orders_guard vigila.
--   · Reutilizar payment_order_proofs con una columna "kind": mezclaría en una
--     sola tabla dos ciclos de vida distintos (el respaldo se adjunta al emitir,
--     el comprobante al pagar) y obligaría a filtrar por kind en cada consulta;
--     olvidarse del filtro una vez muestra comprobantes de pago donde va la
--     factura. Separadas, ese error no se puede escribir.
--   · Subir el tope solo del respaldo y dejar los comprobantes en 5: dos topes
--     distintos para "cuántos archivos puedo subir" es una pregunta que el
--     usuario se hace y nadie puede contestar. El tope de comprobantes sube a
--     10 en el código (MAX_PAYMENT_PROOFS) — no hace falta DDL para eso.
--
-- ⚠️ NO APLICAR AUTOMÁTICAMENTE. Revisar y aplicar a mano (Kevin).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. La tabla ─────────────────────────────────────────────────────────────

create table if not exists public.payment_order_attachments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  -- on delete cascade: borrar un borrador (única orden borrable) se lleva sus
  -- adjuntos. Los objetos del bucket los limpia el endpoint DELETE; acá lo que
  -- importa es no dejar filas colgando de una orden que ya no existe.
  payment_order_id  uuid not null references public.payment_orders(id) on delete cascade,
  -- PATH dentro del bucket PRIVADO `payment-attachments`, nunca una URL
  -- pública: la lectura pasa por /api/admin/payment-orders/[id]/attachment,
  -- que valida sesión + empresa y emite una URL firmada de 10 minutos.
  storage_path      text not null,
  file_name         text,
  mime              text,
  size              integer,
  uploaded_at       timestamptz not null default now(),
  -- auth.users y NO platform_users/company_users: el superadmin de plataforma
  -- no tiene fila en company_users, así que un FK a esa tabla haría fallar el
  -- insert justo cuando opera "viendo como" un tenant (mismo criterio que la
  -- 086 y que el resto del módulo). Nullable: la autoría fina es un extra, el
  -- sello de auditoría fuerte ya está en audit_logs.
  uploaded_by       uuid references auth.users(id) on delete set null,
  -- Orden de exhibición en la UI. No es la clave de nada: solo evita que la
  -- lista baile entre renders cuando dos archivos entran en el mismo segundo.
  sort_order        smallint not null default 0
);

-- Un mismo objeto del bucket no puede estar dos veces en la misma orden: sin
-- esto, un doble submit del formulario duplica la fila y el tope de 10 se
-- consume con archivos repetidos.
alter table public.payment_order_attachments
  drop constraint if exists payment_order_attachments_order_path_key;
alter table public.payment_order_attachments
  add constraint payment_order_attachments_order_path_key
  unique (payment_order_id, storage_path);

-- La consulta que corre siempre: "los adjuntos de esta orden, en orden".
create index if not exists payment_order_attachments_order_idx
  on public.payment_order_attachments (payment_order_id, sort_order, uploaded_at);

-- FK sin índice = seek secuencial en cada borrado de empresa (auditoría 045).
create index if not exists payment_order_attachments_company_idx
  on public.payment_order_attachments (company_id);

comment on table public.payment_order_attachments is
  'Documentos de respaldo de una orden de pago — factura/contrato/cotización que la JUSTIFICAN '
  '(no confundir con payment_order_proofs, que son la prueba del pago). Hasta 10, tope aplicado en '
  'el servidor por MAX_PAYMENT_ATTACHMENTS. Reemplaza a payment_orders.attachment_* — esas columnas '
  'quedan como legado hasta la migración que las elimine.';
comment on column public.payment_order_attachments.storage_path is
  'Path dentro del bucket PRIVADO payment-attachments. Nunca una URL: la lectura emite una URL firmada corta.';
comment on column public.payment_order_attachments.sort_order is
  'Orden de exhibición. Lo asigna el endpoint POST de forma incremental sobre los ya existentes.';

-- ── 2. Backfill de lo que ya está en producción ─────────────────────────────
-- Sin esto, las 8 órdenes que YA tienen respaldo aparecerían sin él apenas el
-- código empiece a leer de la tabla nueva. Los archivos NO se mueven: la fila
-- nueva apunta al MISMO objeto del bucket `payment-attachments`. El
-- `on conflict do nothing` hace la migración idempotente (se puede correr dos
-- veces sin duplicar).

insert into public.payment_order_attachments
  (company_id, payment_order_id, storage_path, file_name, mime, size, uploaded_at, sort_order)
select po.company_id,
       po.id,
       po.attachment_path,
       po.attachment_name,
       po.attachment_mime,
       po.attachment_size,
       -- Órdenes viejas pueden tener el path cargado sin fecha (hoy: ninguna):
       -- se cae a la fecha de creación de la orden antes que a now(), para no
       -- inventar que el archivo se subió el día de la migración.
       coalesce(po.attachment_uploaded_at, po.created_at, now()),
       0
  from public.payment_orders po
 where po.attachment_path is not null
on conflict (payment_order_id, storage_path) do nothing;

-- Las columnas legadas quedan documentadas como tales para que nadie las use
-- como fuente de verdad en un endpoint nuevo.
comment on column public.payment_orders.attachment_path is
  'LEGADO (migración 127): el respaldo vive ahora en payment_order_attachments. Se conserva para permitir rollback del código; una migración posterior la elimina.';
comment on column public.payment_orders.attachment_name is
  'LEGADO (migración 127) — ver payment_order_attachments.file_name.';
comment on column public.payment_orders.attachment_mime is
  'LEGADO (migración 127) — ver payment_order_attachments.mime.';
comment on column public.payment_orders.attachment_size is
  'LEGADO (migración 127) — ver payment_order_attachments.size.';
comment on column public.payment_orders.attachment_uploaded_at is
  'LEGADO (migración 127) — ver payment_order_attachments.uploaded_at.';

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
-- Idéntica a la de payment_order_proofs (migración 086): LECTURA para los
-- miembros de la empresa, ESCRITURA solo por el service role desde los
-- endpoints. No hay policy de insert/update/delete a propósito: con RLS activa
-- y sin policy, el cliente del browser no puede escribir ni una fila, y el
-- admin client (service_role) saltea RLS por completo.
-- auth_company_ids() ya contempla al superadmin (migración 024).

alter table public.payment_order_attachments enable row level security;

drop policy if exists payment_order_attachments_select on public.payment_order_attachments;
create policy payment_order_attachments_select on public.payment_order_attachments
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

commit;

-- ── Verificación posterior (solo lectura) ───────────────────────────────────
--   select count(*) from public.payment_order_attachments;                      -- esperado: 8
--   select count(*) from public.payment_orders where attachment_path is not null; -- 8
--   -- ninguna orden con respaldo puede quedar sin fila en la tabla nueva:
--   select po.id, po.order_number
--     from public.payment_orders po
--     left join public.payment_order_attachments a on a.payment_order_id = po.id
--    where po.attachment_path is not null and a.id is null;                     -- esperado: 0 filas
--   -- y ninguna fila nueva puede apuntar a otra empresa que la de su orden:
--   select count(*) from public.payment_order_attachments a
--     join public.payment_orders po on po.id = a.payment_order_id
--    where po.company_id <> a.company_id;                                       -- esperado: 0
