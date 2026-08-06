-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 059 — Libro de balances por canal
--
-- "Balances por Canal" mostraba un ÚNICO número por canal y por día: el
-- snapshot. Servía para responder "cuánto tengo", pero no "por qué cambió".
-- Este cambio lo convierte en un libro de contabilidad por canal: asientos
-- de ingreso/egreso sobre un saldo inicial, con saldo corrido.
--
-- DOS REGÍMENES (decisión de Kevin, 2026-08-06):
--
--   · Canales por API (coinsbuy, unipayment) → el libro se escribe SOLO
--     automático. El cron de las 00:00 UTC toma los depósitos y retiros del
--     día y los asienta. El "balance en vivo" de la tarjeta sigue siendo el
--     que devuelve la API en el momento; el libro es el histórico diario.
--
--   · Canales manuales (fairpay, wallet_externa, otros, custom_*) → todo a
--     mano: el usuario carga cada ingreso y cada egreso.
--
--   · liquidez / inversiones NO llevan libro acá: ya son libros en sus
--     propios módulos y su saldo se reconstruye desde sus movimientos.
--     Duplicarlos acá sería contarlos dos veces.
--
-- POR QUÉ HAY LÍNEA DE TRANSFERENCIA INTERNA Y LÍNEA DE AJUSTE
--
-- Se verificó contra 6 días de producción que
--     saldo(D+1) = saldo(D) + depósitos(D) − retiros(D)
-- cierra al dólar salvo por dos cosas:
--
--   1. Las TRANSFERENCIAS INTERNAS (api_transactions.internal = true) están
--      excluidas de "Retiros Totales" a propósito — son plata que se mueve
--      entre wallets propias, no un retiro real, y contarlas inflaría el
--      egreso del negocio. Pero SÍ salen del conjunto de wallets pinneadas,
--      así que si el libro las ignora deja de cuadrar con la wallet. El
--      2026-08-04 una transferencia de $70.000 explicaba por sí sola todo
--      el descuadre del día. Van al libro como línea propia y siguen fuera
--      de los totales de P&L.
--
--   2. Las COMISIONES DE RED dejan una diferencia de ~$1 a $4 por día que
--      no aparece en ninguna transacción. Se asienta como "ajuste de
--      conciliación", que es como se trata en tesorería: el libro cierra
--      contra el saldo real del custodio, y la diferencia queda visible en
--      vez de escondida.
--
-- Resultado: el saldo de cierre del libro es SIEMPRE igual al saldo que
-- reportó la API ese día. Si algún día no cuadra, el ajuste lo muestra.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1) Tabla de asientos ─────────────────────────────────────────────────────
create table if not exists public.channel_ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  channel_key  text not null,

  entry_date   date not null,

  -- 'opening' = saldo inicial del libro (uno solo por canal).
  -- 'in' / 'out' = movimiento.
  kind         text not null check (kind in ('opening', 'in', 'out')),

  -- 'api'    → lo escribió el cron; no se edita a mano.
  -- 'manual' → lo cargó una persona.
  source       text not null default 'manual' check (source in ('manual', 'api')),

  concept      text not null,
  category     text,
  reference    text,

  -- Siempre positivo: el signo lo da `kind`. Guardar montos negativos haría
  -- ambiguo el saldo (un 'out' de −100 sumaría).
  amount       numeric(20, 8) not null check (amount >= 0),
  notes        text,

  -- OJO: auth.users, NUNCA platform_users — esa tabla solo tiene a los
  -- superadmins de la plataforma y cualquier insert de un usuario de
  -- empresa fallaría con 23503 (ver migración 054).
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Lectura del libro: siempre por (empresa, canal) y ordenado por fecha.
create index if not exists channel_ledger_entries_lookup
  on public.channel_ledger_entries (company_id, channel_key, entry_date, created_at);

-- Un único saldo inicial por canal.
create unique index if not exists channel_ledger_entries_one_opening
  on public.channel_ledger_entries (company_id, channel_key)
  where kind = 'opening';

-- Idempotencia del cron: si el cron corre dos veces el mismo día (reintento
-- de Vercel, backfill manual), cada línea automática se sobreescribe en vez
-- de duplicarse. `category` discrimina las 4 líneas diarias.
create unique index if not exists channel_ledger_entries_api_daily
  on public.channel_ledger_entries (company_id, channel_key, entry_date, category)
  where source = 'api';

-- `updated_at` al día.
create or replace function public.channel_ledger_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_channel_ledger_touch on public.channel_ledger_entries;
create trigger trg_channel_ledger_touch
  before update on public.channel_ledger_entries
  for each row execute function public.channel_ledger_touch();

-- ── 2) RLS ───────────────────────────────────────────────────────────────────
-- Mismo patrón que el resto de tablas de tenant: lectura para miembros de la
-- empresa, escritura solo vía endpoints server-side (admin client).
alter table public.channel_ledger_entries enable row level security;

drop policy if exists channel_ledger_entries_select on public.channel_ledger_entries;
create policy channel_ledger_entries_select on public.channel_ledger_entries
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

-- ── 3) Movimientos de un día por canal (para el cron) ────────────────────────
-- Reglas de status/wallets IDÉNTICAS a get_period_totals_by_month, para que
-- el libro y los totales del dashboard no puedan divergir. La diferencia es
-- que acá las transferencias internas SÍ se devuelven, en su propia columna.
create or replace function public.get_channel_day_movements(
  p_company_id uuid,
  p_day        date
)
returns table (
  channel_key text,
  deposits    numeric,
  withdrawals numeric,
  internal    numeric
)
language sql
stable
-- SECURITY INVOKER a proposito: con RLS activa, la aislacion por empresa la
-- da la politica y no hay que revalidar p_company_id. Un DEFINER aca seria
-- una fuga multitenant (cualquiera podria pasar el id de otra empresa).
set search_path = public
as $$
  with pinned as (
    select array_agg(wallet_id) as ids
    from public.pinned_coinsbuy_wallets
    where company_id = p_company_id
  ),
  tx as (
    select t.provider, t.amount, coalesce(t.internal, false) as is_internal
    from public.api_transactions t
    cross join pinned p
    where t.company_id = p_company_id
      and (t.transaction_date at time zone 'UTC')::date = p_day
      and (
        (t.provider = 'coinsbuy-deposits'    and t.status = 'Confirmed')
        or (t.provider = 'coinsbuy-withdrawals' and t.status = 'Approved')
        or (t.provider = 'fairpay'           and t.status = 'Completed')
        or (t.provider = 'unipayment'        and t.status = 'Completed')
      )
      -- El scope de wallets pinneadas solo aplica a Coinsbuy.
      and (
        t.provider not in ('coinsbuy-deposits', 'coinsbuy-withdrawals')
        or p.ids is null
        or t.wallet_id = any(p.ids)
      )
  )
  select
    'coinsbuy'::text,
    coalesce(sum(amount) filter (where provider = 'coinsbuy-deposits'), 0),
    coalesce(sum(amount) filter (where provider = 'coinsbuy-withdrawals' and not is_internal), 0),
    coalesce(sum(amount) filter (where provider = 'coinsbuy-withdrawals' and is_internal), 0)
  from tx
  where provider like 'coinsbuy-%'
  having count(*) > 0

  union all

  select 'unipayment'::text,
         coalesce(sum(amount), 0), 0::numeric, 0::numeric
  from tx where provider = 'unipayment' having count(*) > 0

  union all

  select 'fairpay'::text,
         coalesce(sum(amount), 0), 0::numeric, 0::numeric
  from tx where provider = 'fairpay' having count(*) > 0;
$$;

revoke all on function public.get_channel_day_movements(uuid, date) from public, anon;
grant execute on function public.get_channel_day_movements(uuid, date) to authenticated, service_role;

-- ── 4) Saldo del libro a una fecha ───────────────────────────────────────────
-- opening + ingresos − egresos, para todos los asientos con entry_date <= p_asof.
create or replace function public.get_channel_ledger_balances(
  p_company_id uuid,
  p_asof       date
)
returns table (channel_key text, balance numeric)
language sql
stable
-- SECURITY INVOKER a proposito: con RLS activa, la aislacion por empresa la
-- da la politica y no hay que revalidar p_company_id. Un DEFINER aca seria
-- una fuga multitenant (cualquiera podria pasar el id de otra empresa).
set search_path = public
as $$
  select
    e.channel_key,
    sum(case when e.kind = 'out' then -e.amount else e.amount end)::numeric
  from public.channel_ledger_entries e
  where e.company_id = p_company_id
    and e.entry_date <= p_asof
  group by e.channel_key;
$$;

revoke all on function public.get_channel_ledger_balances(uuid, date) from public, anon;
grant execute on function public.get_channel_ledger_balances(uuid, date) to authenticated, service_role;
