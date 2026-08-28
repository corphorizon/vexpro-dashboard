-- ─────────────────────────────────────────────────────────────────────────────
-- Dónde vive el módulo `liquidity_pool` (Pool de Liquidez).
--
-- ── ESTADO AL 2026-08-28 ────────────────────────────────────────────────────
-- Vive en la organización **Exura Liquidez** (`exura-liquidez`), creada ese día
-- para separarlo del resto. Antes estuvo un rato en Exura Prime.
--
-- El módulo NO guarda las cuentas en la empresa donde vive: las cuentas del pool
-- son de la empresa que se elija en el selector de la pantalla. Hoy las 39 son
-- de Vex Pro, que es la única con credenciales de MT5.
--
-- ── POR QUÉ ESTE ARCHIVO YA NO USA `ILIKE '%exura%'` ────────────────────────
-- Porque ahora hay DOS empresas que empiezan con Exura —Exura Prime y Exura
-- Liquidez— y ese patrón las engancha a las dos. Correr la versión vieja hoy
-- volvería a prender el módulo en Exura Prime sin que nadie lo pidiera.
--
-- Se busca por `slug`, que es único y no cambia con el nombre.
-- ─────────────────────────────────────────────────────────────────────────────

-- PASO 1 — Ver dónde está prendido hoy. Debería salir sólo Exura Liquidez.
SELECT name, slug, active_modules
  FROM companies
 WHERE 'liquidity_pool' = ANY(active_modules);

-- PASO 2 — Prenderlo. Idempotente: la segunda corrida afecta 0 filas.
UPDATE companies
   SET active_modules = active_modules || ARRAY['liquidity_pool']
 WHERE slug = 'exura-liquidez'
   AND NOT ('liquidity_pool' = ANY(active_modules));

-- PASO 3 — Apagarlo donde no corresponda. Vacío por defecto: descomentar y
-- poner el slug, para no apagar nada por accidente al correr el archivo entero.
-- UPDATE companies
--    SET active_modules = array_remove(active_modules, 'liquidity_pool')
--  WHERE slug = 'exura-prime';

-- PASO 4 — Verificar. `liquidity_pool` tiene que estar en Exura Liquidez y en
-- NADIE más.
SELECT name, slug
  FROM companies
 WHERE 'liquidity_pool' = ANY(active_modules);
