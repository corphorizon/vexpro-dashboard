-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 129 — tipo de ubicación `debt` (préstamo RECIBIDO por la empresa)
--
-- Pedido de Kevin (2026-10-05): en Balances → «Configurar Balances por Canal»
-- → «Agregar un lugar donde está el dinero», poder registrar un préstamo que
-- una persona le hizo a la empresa, y que quede como DEUDA.
--
-- Por qué hace falta migración: `channel_configs.location_type` tiene un CHECK
-- (migración 070) con la lista cerrada de tipos. Sin ampliarlo, el alta de un
-- `debt` revienta en la base con 23514 aunque la app ya lo ofrezca.
--
-- Semántica (vive en src/lib/cash-locations.ts, no acá):
--   · `holder` = quién prestó (obligatorio; lo valida la API).
--   · El saldo del lugar se guarda POSITIVO (el monto adeudado) y RESTA del
--     total: total = liquid + lent − owed. El signo lo pone `signedBalance`.
--   · No es líquido ni entra al fondo.
--
-- Número: la última en main al escribir esto era la 128
-- (porcentaje-fijo-sin-tramos). Confirmar al mergear (§0 de las reglas).
-- Idempotente: se puede correr dos veces.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.channel_configs
  drop constraint if exists channel_configs_location_type_check;
alter table public.channel_configs
  add constraint channel_configs_location_type_check
  check (location_type in ('gateway', 'wallet', 'bank', 'cash', 'trading', 'loan', 'debt'));

comment on column public.channel_configs.location_type is
  'Dónde está la plata. gateway = pasarela con API (Coinsbuy/UniPayment). loan = prestada: es de la empresa pero no es líquida. debt = préstamo RECIBIDO: pasivo, saldo positivo que resta del total (holder = acreedor).';

comment on column public.channel_configs.holder is
  'Para loan: a quién se le prestó. Para debt: quién le prestó a la empresa (obligatorio). Para bank: el banco.';
