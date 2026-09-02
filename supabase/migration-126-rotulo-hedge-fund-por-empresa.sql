-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 126 — rótulo del módulo Hedge Fund por empresa
--
-- POR QUÉ: Vex Pro comercializa su hedge fund como «Vex Capital» (Kevin,
-- 2026-09-02: «ponle vex capital en vex»). El módulo es el mismo (`hedge_fund`,
-- mismas tablas crm_hf_*, misma pantalla): lo único que cambia es cómo lo llama
-- la empresa en el menú y en el título. Por eso es UNA columna de texto en
-- `companies` y no una tabla de settings ni un jsonb: hay un solo rótulo que
-- varía y meterlo en un jsonb genérico sería crear la "segunda lista" que las
-- reglas del repo prohíben — nadie sabría qué claves viven adentro.
--
-- NULL = la empresa usa el nombre genérico del módulo ('Hedge Fund'). No se
-- escribe '' ni 'Hedge Fund' como default: "no tiene rótulo propio" es un dato
-- distinto de "su rótulo propio es Hedge Fund".
--
-- El bootstrap ya hace `select('*')` sobre companies, así que la columna llega
-- al cliente sin tocar el endpoint.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.companies
  add column if not exists hedge_fund_label text null;

comment on column public.companies.hedge_fund_label is
  'Rotulo comercial del modulo hedge_fund para esta empresa (Vex Pro = Vex Capital). NULL = nombre generico del modulo.';

update public.companies
   set hedge_fund_label = 'Vex Capital'
 where id = '71715987-5479-52c4-a990-c414fb3a9b36'
   and hedge_fund_label is null;
