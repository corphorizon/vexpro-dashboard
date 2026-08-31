-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 115 — hr_net_deposit_by_profile: índices del árbol + timeout propio
--
-- El rollup de RRHH NUNCA cargó en pantalla (Kevin lo reportó tres veces como
-- «no lo veo»): la RPC recorre el árbol de patrocinio con joins por
-- lower(trim(username)) / lower(trim(sponsor_username)) sobre ~21k usuarios,
-- sin ningún índice de expresión → el recursivo excede el statement_timeout
-- de PostgREST y la ruta devuelve 500. Probado por SQL directo (sin ese
-- timeout) la función responde bien — el clásico fallo que en una consola
-- funciona y en la app no.
--
-- Dos defensas: índices de expresión que vuelven indexado cada nivel de la
-- recursión, y un timeout propio de la función (30s) como cinturón — con los
-- índices debería quedar muy por debajo.
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists idx_cus_username_norm
  on public.crm_user_snapshots (company_id, (lower(trim(username))));
create index if not exists idx_cus_sponsor_norm
  on public.crm_user_snapshots (company_id, (lower(trim(sponsor_username))));
create index if not exists idx_crm_deposits_mes
  on public.crm_deposits (company_id, status_norm, deposit_at) include (user_external_id, amount_paid);
create index if not exists idx_crm_withdrawals_mes
  on public.crm_withdrawals (company_id, status_norm, processed_at) include (user_external_id, requested_amount);
alter function public.hr_net_deposit_by_profile(uuid, date) set statement_timeout = '30s';
