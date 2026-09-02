-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 122 — Tercer modelo de negocio: `liquidity_provider`
--
-- ── QUÉ ES ──────────────────────────────────────────────────────────────────
-- Una empresa administradora de POOL DE LIQUIDEZ (Kevin, 2026-09-01):
--   «este sería otro tipo de organización, que solo tendría esa lógica nada más»
--   «dale, dejale también el módulo inversiones»
--   «realmente este es más informativo, por eso solo necesito lo del pool y lo
--    de inversiones»
--
-- Es una entidad INFORMATIVA: mira el aporte al pool sobre cuentas MT5 y el
-- rendimiento de sus inversiones. No lleva contabilidad, no carga datos, no
-- cierra períodos, no reparte a socios y no manda reportes.
--
-- Qué apaga el modelo NO se decide acá: vive en src/lib/business-model.ts
-- (registro único). La base guarda el modelo; el registro decide qué implica.
-- Acá sólo se amplía el catálogo y se mueve la única empresa que lo es.
--
-- ── EL IDENTIFICADOR ────────────────────────────────────────────────────────
-- `liquidity_provider` y NO `liquidity_pool`: esta última ya es la clave de un
-- MÓDULO (`companies.active_modules`) y de una pantalla (/liquidez-pool). El
-- modelo describe a la EMPRESA; el módulo describe la PANTALLA. Dos cosas
-- distintas con el mismo nombre es como nacen las listas que se desincronizan.
--
-- ── ORDEN DE APLICACIÓN — IMPORTA ───────────────────────────────────────────
-- Esta migración tiene que estar APLICADA ANTES de que el código nuevo llegue
-- a producción. Dos motivos:
--   1. Sin el CHECK ampliado, guardar el modelo nuevo desde el panel de
--      superadmin lo rechaza Postgres con un error crudo.
--   2. El código nuevo bloquea el módulo `liquidity_pool` en los modelos que
--      no lo tienen. Exura Liquidez figura hoy como 'broker': entre el deploy
--      y este UPDATE, su pantalla /liquidez-pool responde 403. No se pierde
--      ningún dato; se recupera en cuanto corre este archivo.
--
-- ── POR QUÉ ES SEGURO MOVER A EXURA ─────────────────────────────────────────
-- Medido antes de escribir esto: Exura Liquidez está VACÍA. 0 movimientos de
-- liquidez, 0 inversiones, 0 egresos, 0 api_transactions, 0 depósitos. Sólo 2
-- socios y 2 períodos, sin nada colgando. Ningún número cambia de valor por
-- este cambio de modelo: lo único que cambia es qué pantallas se ven.
-- Los períodos y socios que quedan NO se borran (esta migración no destruye
-- datos): simplemente dejan de tener pantalla. Si alguna vez se revierte el
-- modelo, vuelven a verse tal cual estaban.
--
-- ── EL REPORTE DIARIO EN $0 ─────────────────────────────────────────────────
-- Hallazgo de la auditoría: Exura Liquidez recibía el reporte diario con todo
-- en cero. Con el modelo nuevo, `blockedReportSections` le bloquea las CINCO
-- secciones y `sendReports` ya no la considera elegible (mira el modelo, no
-- sólo `active_modules`). Su fila de `report_configs` NO se toca acá: queda a
-- criterio de Kevin apagarle las secciones o eliminarla — con el código nuevo
-- el mail no sale igual.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.companies
  drop constraint if exists companies_business_model_check;
alter table public.companies
  add constraint companies_business_model_check
  check (business_model in ('broker', 'company', 'liquidity_provider'));

comment on column public.companies.business_model is
  'broker = depositos/retiros/P&L de clientes. company = factura servicios (Horizon). '
  'liquidity_provider = administra un pool de liquidez, informativa (Exura Liquidez). '
  'Registro en src/lib/business-model.ts.';

-- Exura Liquidez — por ID, no por nombre: un nombre se edita desde el panel y
-- esta migración quedaría apuntando a nada, en silencio.
update public.companies
   set business_model = 'liquidity_provider'
 where id = '012b6f0d-ab35-433c-b8f7-dba0a771a8bb';

-- `active_modules` tiene que quedar coherente con el modelo. El guard ya
-- bloquea los módulos que el modelo no admite, así que dejarlos en la fila no
-- abre ninguna pantalla — pero sí se ofrecen al asignar permisos a los
-- usuarios de la empresa, y ahí se leen como si existieran. Se conserva
-- SÓLO lo que el modelo admite: el pool, inversiones, y lo que hace que la
-- app se pueda usar (resumen, usuarios, registro de actividad).
update public.companies
   set active_modules = array['summary', 'liquidity_pool', 'investments', 'users', 'logs']::text[]
 where id = '012b6f0d-ab35-433c-b8f7-dba0a771a8bb';

-- Verificación (correr a mano después de aplicar):
--
--   select name, business_model, active_modules
--     from public.companies
--    where id = '012b6f0d-ab35-433c-b8f7-dba0a771a8bb';
--
--   -- ¿alguna otra empresa quedó con el módulo del pool activo?
--   select name, business_model from public.companies
--    where 'liquidity_pool' = any(active_modules);
