-- ─────────────────────────────────────────────────────────────────────────────
-- Activa el módulo `liquidity_pool` (Pool de Liquidez) SOLO en Exura.
--
-- No es una migración de esquema: no crea ni altera tablas. Es el cambio de
-- configuración que hace visible el módulo nuevo en el sidebar de esa empresa.
--
-- ── LO QUE ESTE SCRIPT NO HACE ──────────────────────────────────────────────
-- NO toca el módulo `liquidity` de nadie. Ese es la conciliación de liquidez
-- que usa Vex Pro (23 cuentas y 35 movimientos cargados) y es otra cosa: tiene
-- sus propias tablas y su propia lógica. Los dos módulos conviven.
--
-- NO toca ninguna empresa que no sea Exura.
-- ─────────────────────────────────────────────────────────────────────────────

-- PASO 1 — Mirar antes de escribir. Confirmá que sale UNA fila y que es Exura.
SELECT id, name, slug, active_modules
  FROM companies
 WHERE name ILIKE '%exura%';

-- PASO 2 — Activar. Idempotente: correrlo dos veces no duplica la clave.
-- El `NOT (... = ANY(...))` hace que la segunda corrida afecte 0 filas en vez
-- de dejar `liquidity_pool` repetido en el array.
UPDATE companies
   SET active_modules = active_modules || ARRAY['liquidity_pool']
 WHERE name ILIKE '%exura%'
   AND NOT ('liquidity_pool' = ANY(active_modules));

-- PASO 3 — Verificar. `liquidity_pool` tiene que aparecer en Exura y en NADIE
-- más. Si aparece en otra empresa, el ILIKE de arriba enganchó de más.
SELECT name, slug, active_modules
  FROM companies
 WHERE 'liquidity_pool' = ANY(active_modules);
