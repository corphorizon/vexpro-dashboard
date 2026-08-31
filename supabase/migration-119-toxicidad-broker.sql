-- APLICADA EL 2026-08-31. El número NO indica el orden real: nació con otro
-- (105/106/107/108) y se renumeró al chocar con las del equipo, que iban por la
-- 115. Ver la nota de numeración en docs/reglas-del-proyecto.md §0.

-- ─────────────────────────────────────────────────────────────────────────────
-- migration-119 — Toxicidad hacia el bróker en el diagnóstico de cuentas.
--
-- ── POR QUÉ COLUMNAS NUEVAS Y NO SE MEZCLA CON `risk` ──────────────────────
-- `risk` / `checks` / `violations` responden «cómo opera este cliente»:
-- martingala, grid, duraciones. Esto responde otra cosa: «esta operativa extrae
-- valor de la ejecución».
--
-- Son casi opuestas. Una cuenta con martingala y sin stop es pésima para el
-- CLIENTE y buen negocio para la casa; una que arbitra latencia es lo
-- contrario. Sumarlas en un solo puntaje daría un número que no significa nada,
-- así que van separadas y la pantalla las muestra en secciones distintas.
--
-- Lo que ya existe NO se toca: esta migración sólo agrega.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE mt5_account_review
  -- De dónde vinieron las órdenes y cómo terminaron: el `Reason` de MT5 en la
  -- apertura y en el cierre, más los nombres de EA sacados de `Comment`.
  --
  -- `Comment` y no `ExpertID`: este bróker devuelve ExpertID = 0 y el nombre
  -- real del bot («EMABOT R1 M1») viaja en el comentario.
  ADD COLUMN IF NOT EXISTS origen jsonb,

  -- Precio ejecutado contra el bid/ask del instante. Medido el 2026-08-31: las
  -- ejecuciones caen EXACTAMENTE en el bid o el ask, así que cualquier desvío
  -- sistemático a favor del cliente destaca sin ruido de fondo.
  ADD COLUMN IF NOT EXISTS ejecucion jsonb,

  -- Las señales de toxicidad, con su `hit` en true / false / null.
  -- `null` es «no se pudo comprobar» y NO cuenta como limpio.
  ADD COLUMN IF NOT EXISTS toxic_signals jsonb,

  -- Nivel resumido de ESTE eje: ok | medio | alto. Independiente de `risk`.
  ADD COLUMN IF NOT EXISTS toxic_level text,
  ADD COLUMN IF NOT EXISTS toxic_flagged integer;

COMMENT ON COLUMN mt5_account_review.toxic_level IS
  'Toxicidad hacia el BROKER (ok/medio/alto). Eje independiente de `risk`, que '
  'mide cómo opera el cliente. Una cuenta puede ser riesgo alto para el cliente '
  'y cero tóxica para la casa, y al revés.';

COMMENT ON COLUMN mt5_account_review.origen IS
  'Reason de MT5 en apertura y cierre + nombres de EA sacados de Comment. '
  'ExpertID viene en 0 en este broker, así que Comment es la identidad real '
  'del bot. Un Reason=MOBILE con comentario de EA es un bot por el móvil.';

-- Verificación — tienen que salir las cinco columnas.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'mt5_account_review'
   AND column_name IN ('origen', 'ejecucion', 'toxic_signals', 'toxic_level', 'toxic_flagged')
 ORDER BY column_name;
