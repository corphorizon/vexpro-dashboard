-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 054 — Órdenes de Pago (módulo de tesorería)
--
-- Documento formal que autoriza la salida de fondos. Sigue los controles
-- estándar de tesorería:
--
--   · NUMERACIÓN CORRELATIVA por empresa y año (OP-2026-0001), generada de
--     forma atómica en DB — nunca en el cliente, nunca con huecos por
--     concurrencia.
--   · SEGREGACIÓN DE FUNCIONES (maker-checker): quien crea la orden NO puede
--     aprobarla. Se valida en el endpoint Y en el trigger de abajo.
--   · INMUTABILIDAD: una vez aprobada, los campos económicos y del
--     beneficiario quedan congelados. Un error se corrige ANULANDO y
--     emitiendo una nueva (igual que un comprobante fiscal), nunca editando.
--   · TRAZABILIDAD: cada transición guarda quién y cuándo. El nombre se
--     desnormaliza (created_by_name…) para que el PDF histórico no cambie si
--     el usuario se renombra o se elimina.
--   · IDENTIDAD: los *_by referencian auth.users — company_users.user_id y
--     platform_users.id apuntan ahí. NO usar platform_users como FK: solo
--     contiene superadmins de Horizon (2 filas), así que un admin de empresa
--     no existe en esa tabla y todo insert suyo fallaría con 23503.
--   · LIBRETA DE BENEFICIARIOS: reutilizar datos verificados en vez de
--     re-tipear wallets/IBAN es el control anti-fraude más efectivo
--     (un typo en una wallet = fondos perdidos sin reversa).
--
-- Estados: draft → pending → approved → paid
--                    ↓          ↓
--                rejected   cancelled
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Beneficiarios recurrentes (libreta) ──────────────────────────────────────
create table if not exists payment_beneficiaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  tax_id text,
  email text,
  country text,
  -- Último método usado — precarga el formulario, siempre editable.
  default_payment_method text check (default_payment_method in ('crypto','bank')),
  crypto_network text,
  crypto_wallet text,
  crypto_memo text,
  bank_name text,
  bank_account_holder text,
  bank_account_number text,
  bank_swift text,
  bank_account_type text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_beneficiaries_company
  on payment_beneficiaries(company_id, name);

-- ── Órdenes de pago ──────────────────────────────────────────────────────────
create table if not exists payment_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- Correlativo: OP-2026-0001. Único por empresa (ver next_payment_order_number).
  order_number text not null,

  status text not null default 'draft'
    check (status in ('draft','pending','approved','paid','rejected','cancelled')),

  -- Idioma del PDF, independiente del idioma de la UI de quien la emite:
  -- una orden a un proveedor extranjero se emite en inglés aunque el equipo
  -- trabaje en español.
  locale text not null default 'es' check (locale in ('es','en')),

  issue_date date not null default current_date,
  payment_date date,

  -- ── Beneficiario (se copia de la libreta; la orden guarda su propia foto
  --    de los datos para que editar el beneficiario no altere el histórico) ──
  beneficiary_id uuid references payment_beneficiaries(id) on delete set null,
  beneficiary_name text not null,
  beneficiary_tax_id text,
  beneficiary_email text,
  beneficiary_country text,

  -- ── Detalle ──
  -- jsonb: [{ description, unitValue, quantity, amount }]. Las líneas no se
  -- consultan por separado y siempre se leen con la orden — una tabla hija
  -- solo agregaría joins sin beneficio.
  lines jsonb not null default '[]'::jsonb,
  currency text not null default 'USD',
  subtotal numeric(14,2) not null default 0,
  fees numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,

  -- ── Medio de pago ──
  payment_method text not null check (payment_method in ('crypto','bank')),
  crypto_network text,        -- TRC20 | ERC20 | BEP20 | Polygon | Solana | Arbitrum | <texto libre>
  crypto_wallet text,
  crypto_memo text,
  bank_name text,
  bank_account_holder text,
  bank_account_number text,
  bank_swift text,
  bank_account_type text,

  notes text,

  -- ── Workflow / auditoría ──
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_by_name text,
  rejected_at timestamptz,
  rejection_reason text,
  paid_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  paid_by_name text,
  payment_reference text,     -- txid de la blockchain / referencia bancaria
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_by_name text,
  cancellation_reason text,

  -- Egreso generado al marcar pagada (opcional, decisión de Kevin 2026-08-03).
  expense_id uuid references expenses(id) on delete set null,

  updated_at timestamptz not null default now(),

  constraint payment_orders_number_unique unique (company_id, order_number)
);

create index if not exists idx_payment_orders_company_status
  on payment_orders(company_id, status, issue_date desc);
create index if not exists idx_payment_orders_company_created
  on payment_orders(company_id, created_at desc);

-- ── Correlativo atómico ──────────────────────────────────────────────────────
-- Toma el máximo del año en curso para la empresa y suma 1, bajo un lock de
-- transacción por empresa (advisory lock sobre el hash del company_id) para
-- que dos usuarios creando a la vez no colisionen.
create or replace function public.next_payment_order_number(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text := to_char(current_date, 'YYYY');
  v_seq int;
begin
  perform pg_advisory_xact_lock(hashtext(p_company_id::text));

  select coalesce(max((regexp_replace(order_number, '^OP-\d{4}-', ''))::int), 0) + 1
    into v_seq
  from payment_orders
  where company_id = p_company_id
    and order_number like 'OP-' || v_year || '-%';

  return 'OP-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

revoke execute on function public.next_payment_order_number(uuid) from anon, authenticated;

-- ── Guardas de integridad del workflow ───────────────────────────────────────
-- Defensa en profundidad: el endpoint ya valida, pero un bug (o un acceso
-- directo con service_role) no debe poder romper los dos controles que
-- sostienen el valor del documento.
create or replace function public.payment_orders_guard()
returns trigger
language plpgsql
as $$
begin
  -- 1) Segregación de funciones: el aprobador nunca puede ser el creador.
  if new.approved_by is not null and new.approved_by = new.created_by then
    raise exception 'Segregación de funciones: quien crea la orden no puede aprobarla';
  end if;

  -- 2) Inmutabilidad post-aprobación: aprobada/pagada solo admite avanzar de
  --    estado y completar los campos de pago/anulación. Los montos, el
  --    beneficiario y los datos bancarios quedan congelados.
  if tg_op = 'UPDATE' and old.status in ('approved','paid') then
    if new.total is distinct from old.total
       or new.subtotal is distinct from old.subtotal
       or new.fees is distinct from old.fees
       or new.lines is distinct from old.lines
       or new.currency is distinct from old.currency
       or new.beneficiary_name is distinct from old.beneficiary_name
       or new.beneficiary_tax_id is distinct from old.beneficiary_tax_id
       or new.payment_method is distinct from old.payment_method
       or new.crypto_wallet is distinct from old.crypto_wallet
       or new.crypto_network is distinct from old.crypto_network
       or new.bank_account_number is distinct from old.bank_account_number
       or new.bank_swift is distinct from old.bank_swift
       or new.order_number is distinct from old.order_number
    then
      raise exception 'Una orden aprobada es inmutable: anulala y emití una nueva';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_payment_orders_guard on payment_orders;
create trigger trg_payment_orders_guard
  before insert or update on payment_orders
  for each row execute function public.payment_orders_guard();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Mismo patrón que el resto de tablas de tenant: lectura para miembros de la
-- empresa, escritura solo vía endpoints server-side (admin client). Las
-- políticas cubren el caso de que alguien consulte con el cliente del browser.
alter table payment_orders enable row level security;
alter table payment_beneficiaries enable row level security;

drop policy if exists payment_orders_select on payment_orders;
create policy payment_orders_select on payment_orders
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists payment_beneficiaries_select on payment_beneficiaries;
create policy payment_beneficiaries_select on payment_beneficiaries
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));
