-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 104 — Reparto de duraciones por cuenta en el diagnóstico operativo
--
-- QUÉ SE PIDIÓ (Stiven, 2026-08-27)
-- Ver por cuenta el mismo desglose que ya existe en la pantalla de subida:
-- cuántas operaciones caen en cada tramo de duración y cuánto dinero hizo cada
-- tramo. Es la lectura que separa «hace scalping» de «gana con el scalping»,
-- que son cosas distintas y hoy no se distinguen.
--
-- POR QUÉ UNA COLUMNA Y NO SE CALCULA AL LEER
-- Porque calcularlo exige las operaciones una por una, y ésas viven en MT5:
-- volver a traerlas al abrir la ficha es justo lo que este módulo evita (el
-- túnel cuesta ~3,5 s y sería una conexión al broker por visita). El reparto ya
-- se computa durante el cron; sólo faltaba guardarlo.
--
-- Los tramos son los de `BUCKET_DEFINITIONS` (<1, 1-2, 2-3, 3-4, 4-5, 5-10,
-- >10 min), los mismos que la pantalla de subida — una sola definición para que
-- dos pantallas no muestren repartos distintos del mismo dato.
-- ─────────────────────────────────────────────────────────────────────────────

alter table mt5_account_review
  add column if not exists durations jsonb not null default '[]'::jsonb;

comment on column mt5_account_review.durations is
  'Reparto por tramo de duracion: [{label, count, profit}]. Tramos de BUCKET_DEFINITIONS.';
