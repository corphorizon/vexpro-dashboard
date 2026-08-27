-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 103 — crm_user_snapshots: ib_rewards + hierarchy
--
-- Pedido por Atlas (2026-08-28) para GET /api/partner/v1/customers:
--   · ib_rewards: lo cobrado como IB por línea de negocio, EN DÓLARES
--     (verificado contra docs reales: decimales — centavos sería entero).
--   · hierarchy: cadena de ANCESTROS (raíz→patrocinador) reducida a
--     [{userId, position}]; position es profundidad DESDE LA RAÍZ.
--
-- NULABLES A PROPÓSITO, sin DEFAULT: null = "aún no re-sincronizado con el
-- normalizador nuevo" (las 21k filas existentes), [] = "cima de su
-- estructura", {} nunca. Un DEFAULT habría escrito "no cobró nada / no tiene
-- ancestros" en filas donde simplemente no lo sabemos todavía.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.crm_user_snapshots
  add column if not exists ib_rewards jsonb,
  add column if not exists hierarchy jsonb;
