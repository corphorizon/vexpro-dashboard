-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 128 — Excepción por perfil a los tramos de % por volumen
--
-- (Nació como 125, pero 125-127 las tomó el módulo Hedge Fund y compañía en
--  la rama de Kevin — segunda colisión del día, resuelta al mergear como manda
--  el §0. Solo cambió el número del archivo: el ALTER ya estaba aplicado y es
--  idéntico.)
--
-- ── QUÉ PROBLEMA RESUELVE ───────────────────────────────────────────────────
-- Los BDM tienen tramos de % por volumen de ND (BDM_PCT_TIERS en
-- src/lib/commission-calculator.ts: ≥200k→6%, ≥100k→5%, ≥50k→4%) y desde la
-- auditoría 2026-08-06 la regla es que el tramo es un PISO: se paga
-- max(tramo, % del perfil). El dueño pidió (2026-09-03) poder EXCEPTUAR a una
-- persona: que cobre SIEMPRE su % pactado, haga el volumen que haga. Caso que
-- lo motivó: Ana García tiene 4% pactado y agosto (ND $283.139) la subía al
-- tramo del 6%.
--
-- `nd_pct_fixed = true` ⇒ los tramos NO aplican (ni para subir): el % es el de
-- `net_deposit_pct`, punto. El default false deja a TODOS exactamente como
-- estaban — la regla del piso sigue vigente salvo excepción explícita.
--
-- SOLO afecta el % de COMISIÓN. Los tramos de SALARIO (SALARY_TIERS /
-- HEAD_SALARY_TIERS) no se tocan: esa excepción ya existe y es otra
-- (`fixed_salary`).
--
-- La aplica src/lib/commission-calculator.ts (calculateBdmPctFromND, parámetro
-- pctFixed) en todos sus consumidores; el flag se edita en el modal
-- "Editar Perfil Comercial" de Gestión RRHH y, como pnl_special_mode, se apaga
-- solo si el perfil pierde su net_deposit_pct (sin % no hay excepción que
-- guardar).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.commercial_profiles
  add column if not exists nd_pct_fixed boolean not null default false;

comment on column public.commercial_profiles.nd_pct_fixed is
  'true = el % de net_deposit_pct es FIJO: los tramos de comision por volumen '
  '(BDM_PCT_TIERS) no aplican, ni siquiera para mejorar. false (default) = '
  'regla del piso de la auditoria 2026-08-06: se paga max(tramo, % del perfil). '
  'No afecta los tramos de SALARIO (eso es fixed_salary).';

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano después de aplicar):
--
-- select name, net_deposit_pct, nd_pct_fixed
--   from commercial_profiles
--  where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--    and net_deposit_pct is not null
--  order by name;
--
-- Todos deben salir con nd_pct_fixed = false (nadie cambia hasta que se marque
-- el checkbox en su perfil).
-- ─────────────────────────────────────────────────────────────────────────────
