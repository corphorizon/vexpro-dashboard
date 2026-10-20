-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 132 — Cache materializada de los insumos CRM de /comisiones
--
-- (132 y no otro: el último archivo del repo es el 131, de Kevin. Verificado
--  con `git fetch` + `ls supabase/migration-*.sql | tail -3` el 2026-10-20. El
--  número se RE-ELIGE AL MERGEAR si otra rama lo tomó — §0 de
--  docs/reglas-del-proyecto.md.)
--
-- ── POR QUÉ (incidente de septiembre 2026, dueño, 2026-10-20) ──────────────
-- /comisiones pedía sus insumos del CRM a GET /api/admin/commission-net-input,
-- que corría EN VIVO, en cada visita, las dos RPC pesadas sobre ~28.000
-- snapshots: `hr_net_deposit_by_profile` (migraciones 097→121→123) y
-- `hr_pnl_input_by_profile` (123, que es la que lee `crm_ib_reward_daily` para
-- los lotes). Cada una tiene `statement_timeout = 30s` propio, y el cliente
-- reintenta tres veces (0 + 1,5 + 4 s de espera): una visita mala son ~95 s
-- de «Cargando…» seguidos de «sin datos». Eso es lo que el dueño midió como
-- «tarda 30-90 s».
--
-- Mientras tanto la pantalla muestra «sin datos», y si alguien aprieta Guardar
-- en esa ventana FIJA valores incompletos. Ya pasó: septiembre se cerró con
-- grupos a medias. Es el modo de falla de §1.2 en su forma más cara: nada lanza
-- una excepción, el guardado sale «bien» y el número es plausible y falso.
--
-- ── QUÉ HACE ───────────────────────────────────────────────────────────────
-- El cómputo pesado sale del camino de la pantalla:
--   · lo corre el cron `sync-crm` (modo espejo diario y modo completo cada
--     4 h) para el mes en curso y el anterior, y el botón «Actualizar» de la
--     pantalla (POST /api/admin/commission-net-input/refresh);
--   · el resultado queda acá, y el GET lee esto (un select por empresa+mes).
-- El ÚNICO que escribe es `src/lib/hr/insumos-comisiones.ts`
-- (`recomputarInsumosComisiones`), a través de la función de abajo.
--
-- ── EL SIGNO DEL PnL NO SE TOCA ACÁ ────────────────────────────────────────
-- `pnl_crm` se guarda TAL CUAL sale de `hr_pnl_input_by_profile`: signo CRUDO
-- del CRM (negativo = los clientes perdieron = el bróker ganó). El ÚNICO punto
-- de inversión de todo el camino sigue siendo GET
-- /api/admin/commission-net-input (ver su cabecera). Guardarlo invertido acá
-- sería un segundo lugar que invierte: dos inversiones se cancelan y ninguna
-- paga al revés, y las dos cosas dan un número plausible (§1.2).
--
-- ── null ≠ 0 ───────────────────────────────────────────────────────────────
-- Una métrica que la RPC no trajo queda NULL, nunca 0. Los tres estados de la
-- 123 (las tres columnas PnL en NULL = el perfil no tiene usuario en el CRM;
-- 0 = cero medido; pnl NULL con lotes numérico = no calculable) se conservan
-- tal cual porque se guarda el crudo.
--
-- ── LO QUE SE AGREGÓ A LO PEDIDO, Y POR QUÉ ────────────────────────────────
-- El pedido era una sola tabla (company_id, mes, profile_id, nd, nd_clients,
-- pnl_crm, lotes, computed_at). Con sólo eso la cache NO reproduce la
-- respuesta de hoy, y la diferencia no da error:
--   · `usuarios_red`: la respuesta lo manda (`usuariosRed`, el tamaño de la
--     subred que hace auditable el PnL). Sin la columna, se perdía.
--   · `en_rpc_nd` / `en_rpc_pnl`: QUÉ RPC trajo la fila. Sin esto un perfil
--     con las tres columnas PnL en NULL es indistinguible de un perfil que no
--     es del grupo PnL — y la pantalla contaría «sin dato CRM» a gente que no
--     cobra por PnL (`countSinDatoCrm`).
--   · la tabla de CABECERA `hr_insumos_comisiones_mes`, por tres cosas que no
--     tienen fila de perfil donde vivir:
--       1. `nd_huerfano`: el net de los clientes sin perfil (la fila con
--          `profile_id` NULL de la RPC). La PK de la tabla de filas no admite
--          NULL; sin esto `totalCrm` mentiría por exactamente lo huérfano.
--       2. `nd_computed_at` / `pnl_computed_at`: la frescura POR MÉTRICA. Con
--          el merge por columna (abajo) el ND y el PnL de un mes pueden tener
--          edades distintas; un único `computed_at` por fila diría que un PnL
--          de ayer es de hoy.
--       3. distinguir «nunca se calculó» (no hay cabecera, o el ND nunca salió
--          bien → el GET calcula en vivo) de «se calculó y la RPC no trajo
--          filas» (cabecera con fecha y cero filas → un mes vacío de verdad).
--
-- ── MERGE POR COLUMNA: un timeout no degrada una cache buena ───────────────
-- Si una RPC falla entera, sus columnas NO se tocan: el ND y el PnL se aplican
-- por separado, y el parámetro de la métrica que falló llega NULL. Así un
-- timeout del PnL a las 03:35 deja el PnL de las 23:35 (viejo, válido, con su
-- hora a la vista) en vez de NULLs que la pantalla leería como «sin dato
-- CRM». Cuando una métrica SÍ llegó, se reemplaza ENTERA para ese mes:
-- quien ya no viene en la RPC pierde esas columnas (no se arrastra un número
-- de un perfil que la RPC dejó de devolver).
--
-- Todo eso pasa en UNA función plpgsql = UNA transacción: un lector nunca ve
-- un mes a medio escribir (filas nuevas con cabecera vieja, o el ND de un
-- perfil sin el de su vecino). Y un advisory lock por (empresa, mes) serializa
-- al cron y al botón si coinciden.
--
-- ── DESCARTADO ─────────────────────────────────────────────────────────────
--   · Optimizar las RPC con más índices. La 115 y la 123 ya los pusieron, y
--     el costo es estructural: recorrer el árbol de patrocinio entero por
--     request. Más rápidas siguen siendo O(árbol) en el camino de la pantalla,
--     y con dos cambios de mes seguidos ya se midió el net pasar de ~2 s a
--     ~16 s por competencia (2026-09-11). El problema es CUÁNDO se calcula,
--     no cuánto tarda.
--   · Computar en el cliente: peor. Bajaría ~28.000 snapshots al navegador por
--     visita y la regla de §2.3 / migración 079 es justamente la contraria
--     («la plata no puede depender de la corrección del navegador»).
--   · Merge en TypeScript (leer la cache, mezclar, escribir con 3 llamadas).
--     Sin transacción entre el upsert de filas, el borrado de las que sobran
--     y la cabecera, un lector en el medio ve un mes inconsistente. La regla
--     de merge vive SOLO acá; TypeScript decide QUÉ métrica viaja.
--   · Cachear también los perfiles (la estructura). Se siguen leyendo en vivo
--     en el GET: son ~126 filas, y la estructura es la que la pantalla ya usa
--     en todo lo demás. Un cambio de estructura posterior al cálculo se ve al
--     apretar «Actualizar»; la hora del cálculo está en pantalla.
--
-- ── ORDEN DE DESPLIEGUE ────────────────────────────────────────────────────
-- El código tolera que esta migración NO esté aplicada: si la lectura de la
-- cache falla, el GET calcula en vivo como antes (y avisa en el log). No hay
-- ventana rota entre el deploy y la migración.
--
-- Idempotente: `create table if not exists`, `drop policy if exists`,
-- `create or replace function`.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Cabecera por (empresa, mes) ──────────────────────────────────────────
create table if not exists public.hr_insumos_comisiones_mes (
  company_id       uuid not null references public.companies(id) on delete cascade,

  /** Primer día del mes. Es la única forma que aceptan las dos RPC. */
  mes              date not null,

  /** Net de los clientes SIN perfil (la fila `profile_id` NULL de
      `hr_net_deposit_by_profile`). NULL = la RPC no trajo fila huérfana, o el
      ND nunca se calculó (mirar `nd_computed_at`). Se MUESTRA, no se reparte
      (migración 097). */
  nd_huerfano      numeric,

  /** Último cálculo EXITOSO del net deposit. NULL = nunca salió bien: el GET
      lo trata como «sin cache» y calcula en vivo. */
  nd_computed_at   timestamptz,

  /** Último cálculo EXITOSO del insumo PnL. NULL = nunca salió bien: el GET
      devuelve `pnlEntries: null` + `pnlError`, igual que cuando la RPC falla
      en vivo. */
  pnl_computed_at  timestamptz,

  /** Último INTENTO de escritura (aunque una métrica haya fallado). */
  computed_at      timestamptz not null default now(),

  primary key (company_id, mes),
  constraint hr_insumos_comisiones_mes_dia_1 check (mes = date_trunc('month', mes)::date)
);

comment on table public.hr_insumos_comisiones_mes is
  'Cabecera de la cache de insumos CRM de /comisiones (migracion 132): el net huerfano y la frescura POR METRICA. La escribe solo hr_insumos_comisiones_aplicar.';

-- ── 2. Una fila por (empresa, mes, perfil) ──────────────────────────────────
create table if not exists public.hr_insumos_comisiones (
  company_id   uuid not null references public.companies(id) on delete cascade,
  mes          date not null,
  profile_id   uuid not null references public.commercial_profiles(id) on delete cascade,

  /** Net deposit PROPIO del perfil (`net` de hr_net_deposit_by_profile), tal
      cual. El total del subárbol lo arma buildRollup al leer. NULL con
      `en_rpc_nd = false` = la RPC no trajo fila para este perfil. */
  nd           numeric,
  /** `clients` de la misma RPC. */
  nd_clients   integer,

  /** SIGNO CRUDO DEL CRM (negativo = los clientes perdieron = el bróker
      ganó). NO se invierte acá: el único punto de inversión es GET
      /api/admin/commission-net-input. */
  pnl_crm      numeric,
  /** `com_lotes` de hr_pnl_input_by_profile (Commissions Report del CRM,
      sale de crm_ib_reward_daily). */
  lotes        numeric,
  /** `usuarios_red` de la misma RPC: el tamaño de la subred del PnL. */
  usuarios_red integer,

  /** La fila vino en la salida de hr_net_deposit_by_profile. */
  en_rpc_nd    boolean not null default false,
  /** La fila vino en la salida de hr_pnl_input_by_profile. Distingue «perfil
      PnL sin usuario CRM» (true + tres NULL) de «no es del grupo PnL». */
  en_rpc_pnl   boolean not null default false,

  /** Última vez que se escribió ESTA fila. La frescura por métrica está en
      la cabecera (`nd_computed_at` / `pnl_computed_at`). */
  computed_at  timestamptz not null default now(),

  primary key (company_id, mes, profile_id),
  constraint hr_insumos_comisiones_dia_1 check (mes = date_trunc('month', mes)::date)
);

comment on table public.hr_insumos_comisiones is
  'Cache materializada de los insumos CRM de /comisiones por perfil y mes (migracion 132). pnl_crm va con el signo CRUDO del CRM: invertirlo es tarea de /api/admin/commission-net-input, unico punto de inversion. NULL = la RPC no lo trajo, nunca cero. La escribe solo hr_insumos_comisiones_aplicar (service_role).';

comment on column public.hr_insumos_comisiones.pnl_crm is
  'Signo CRUDO del CRM (negativo = el cliente perdio). NO invertir aca: el unico punto de inversion es GET /api/admin/commission-net-input.';

-- ── 3. RLS: lectura por empresa, escritura sólo service_role ────────────────
-- Mismo patrón que las tablas espejo (054, 122, 125): lectura para los
-- miembros de la empresa; sin policies de escritura, porque escribe el
-- servidor con el service role, que saltea RLS.
alter table public.hr_insumos_comisiones_mes enable row level security;
alter table public.hr_insumos_comisiones     enable row level security;

drop policy if exists hr_insumos_comisiones_mes_select on public.hr_insumos_comisiones_mes;
create policy hr_insumos_comisiones_mes_select on public.hr_insumos_comisiones_mes
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists hr_insumos_comisiones_select on public.hr_insumos_comisiones;
create policy hr_insumos_comisiones_select on public.hr_insumos_comisiones
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

-- ── 4. La escritura: merge por columna, en una transacción ──────────────────
-- p_nd  = NULL si la RPC del net falló (no se toca nada del ND), o
--         {"huerfano": numeric|null,
--          "filas": [{"profile_id", "nd", "nd_clients"}, ...]}
-- p_pnl = NULL si la RPC del PnL falló (no se toca nada del PnL), o
--         {"filas": [{"profile_id", "pnl_crm", "lotes", "usuarios_red"}, ...]}
--
-- Las filas cuyo perfil NO es de esa empresa se DESCARTAN y se CUENTAN
-- (`descartadas` en la respuesta): defensa de tenant, y un perfil borrado
-- entre la RPC y la escritura no tumba la transacción entera. TypeScript
-- convierte `descartadas > 0` en un error visible: contado, no silenciado.
create or replace function public.hr_insumos_comisiones_aplicar(
  p_company_id uuid,
  p_mes        date,
  p_nd         jsonb,
  p_pnl        jsonb
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_now         timestamptz := now();
  v_descartadas integer := 0;
  v_n           integer;
  v_filas       integer;
  v_cab         record;
begin
  if p_company_id is null then
    raise exception 'p_company_id es obligatorio';
  end if;
  if p_mes is null or p_mes <> date_trunc('month', p_mes)::date then
    raise exception 'p_mes tiene que ser el primer dia del mes (recibido: %)', p_mes;
  end if;

  -- El cron y el botón «Actualizar» pueden coincidir sobre el mismo mes: se
  -- serializan acá. Se libera solo al terminar la transacción.
  perform pg_advisory_xact_lock(
    hashtextextended('hr_insumos_comisiones:' || p_company_id::text || ':' || p_mes::text, 0)
  );

  insert into public.hr_insumos_comisiones_mes as c (company_id, mes, computed_at)
  values (p_company_id, p_mes, v_now)
  on conflict (company_id, mes) do update set computed_at = excluded.computed_at;

  -- ── ND ────────────────────────────────────────────────────────────────────
  if p_nd is not null then
    -- Quien ya no viene en la RPC pierde el ND: la métrica se reemplaza
    -- ENTERA para el mes, no se arrastra el número de un perfil que salió.
    update public.hr_insumos_comisiones t
       set nd = null, nd_clients = null, en_rpc_nd = false, computed_at = v_now
     where t.company_id = p_company_id
       and t.mes = p_mes
       and t.en_rpc_nd
       and not exists (
         select 1
           from jsonb_array_elements(coalesce(p_nd->'filas', '[]'::jsonb)) f
          where (f->>'profile_id')::uuid = t.profile_id
       );

    with entrada as (
      select (f->>'profile_id')::uuid     as profile_id,
             (f->>'nd')::numeric          as nd,
             (f->>'nd_clients')::integer  as nd_clients
        from jsonb_array_elements(coalesce(p_nd->'filas', '[]'::jsonb)) f
    )
    insert into public.hr_insumos_comisiones as t
           (company_id, mes, profile_id, nd, nd_clients, en_rpc_nd, computed_at)
    select p_company_id, p_mes, e.profile_id, e.nd, e.nd_clients, true, v_now
      from entrada e
      join public.commercial_profiles cp
        on cp.id = e.profile_id and cp.company_id = p_company_id
    on conflict (company_id, mes, profile_id) do update
       set nd = excluded.nd,
           nd_clients = excluded.nd_clients,
           en_rpc_nd = true,
           computed_at = excluded.computed_at;
    get diagnostics v_n = row_count;
    v_descartadas := v_descartadas
      + jsonb_array_length(coalesce(p_nd->'filas', '[]'::jsonb)) - v_n;

    update public.hr_insumos_comisiones_mes
       set nd_huerfano = (p_nd->>'huerfano')::numeric,
           nd_computed_at = v_now
     where company_id = p_company_id and mes = p_mes;
  end if;

  -- ── PnL ───────────────────────────────────────────────────────────────────
  if p_pnl is not null then
    update public.hr_insumos_comisiones t
       set pnl_crm = null, lotes = null, usuarios_red = null, en_rpc_pnl = false, computed_at = v_now
     where t.company_id = p_company_id
       and t.mes = p_mes
       and t.en_rpc_pnl
       and not exists (
         select 1
           from jsonb_array_elements(coalesce(p_pnl->'filas', '[]'::jsonb)) f
          where (f->>'profile_id')::uuid = t.profile_id
       );

    with entrada as (
      select (f->>'profile_id')::uuid      as profile_id,
             (f->>'pnl_crm')::numeric      as pnl_crm,
             (f->>'lotes')::numeric        as lotes,
             (f->>'usuarios_red')::integer as usuarios_red
        from jsonb_array_elements(coalesce(p_pnl->'filas', '[]'::jsonb)) f
    )
    insert into public.hr_insumos_comisiones as t
           (company_id, mes, profile_id, pnl_crm, lotes, usuarios_red, en_rpc_pnl, computed_at)
    select p_company_id, p_mes, e.profile_id, e.pnl_crm, e.lotes, e.usuarios_red, true, v_now
      from entrada e
      join public.commercial_profiles cp
        on cp.id = e.profile_id and cp.company_id = p_company_id
    on conflict (company_id, mes, profile_id) do update
       set pnl_crm = excluded.pnl_crm,
           lotes = excluded.lotes,
           usuarios_red = excluded.usuarios_red,
           en_rpc_pnl = true,
           computed_at = excluded.computed_at;
    get diagnostics v_n = row_count;
    v_descartadas := v_descartadas
      + jsonb_array_length(coalesce(p_pnl->'filas', '[]'::jsonb)) - v_n;

    update public.hr_insumos_comisiones_mes
       set pnl_computed_at = v_now
     where company_id = p_company_id and mes = p_mes;
  end if;

  -- Una fila que ninguna de las dos RPC trae ya no dice nada.
  delete from public.hr_insumos_comisiones t
   where t.company_id = p_company_id
     and t.mes = p_mes
     and not t.en_rpc_nd
     and not t.en_rpc_pnl;

  select count(*)::integer into v_filas
    from public.hr_insumos_comisiones
   where company_id = p_company_id and mes = p_mes;

  select nd_computed_at, pnl_computed_at into v_cab
    from public.hr_insumos_comisiones_mes
   where company_id = p_company_id and mes = p_mes;

  return jsonb_build_object(
    'filas',           v_filas,
    'descartadas',     v_descartadas,
    'computed_at',     v_now,
    'nd_computed_at',  v_cab.nd_computed_at,
    'pnl_computed_at', v_cab.pnl_computed_at
  );
end;
$function$;

comment on function public.hr_insumos_comisiones_aplicar(uuid, date, jsonb, jsonb) is
  'Escribe la cache de insumos CRM de /comisiones (migracion 132) con MERGE POR COLUMNA: p_nd o p_pnl en NULL = esa RPC fallo y sus columnas NO se tocan (un timeout no degrada una cache buena a NULLs). Una transaccion + advisory lock por (empresa, mes). Solo service_role.';

-- Sólo el servidor escribe. SECURITY INVOKER (el default) + RLS sin policies
-- de escritura ya lo impedirían para `authenticated`, pero el grant lo dice
-- explícito: ni siquiera se puede llamar.
revoke all on function public.hr_insumos_comisiones_aplicar(uuid, date, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.hr_insumos_comisiones_aplicar(uuid, date, jsonb, jsonb) to service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano DESPUÉS de aplicar, y después del primer cron
-- o del primer «Actualizar»). Reemplazar :empresa y :mes.
--
-- A) La cache cuadra con la RPC en vivo: las dos consultas tienen que dar el
--    MISMO total y la MISMA cantidad de filas con perfil. Si difieren con un
--    cálculo de hace minutos, el cruce está roto (no "cambió un poquito").
--
--   select count(*) filter (where profile_id is not null) as perfiles,
--          sum(net) as total
--     from public.hr_net_deposit_by_profile(:empresa, :mes);
--
--   select count(*) filter (where en_rpc_nd) as perfiles,
--          coalesce(sum(nd) filter (where en_rpc_nd), 0)
--            + coalesce((select nd_huerfano from public.hr_insumos_comisiones_mes
--                         where company_id = :empresa and mes = :mes), 0) as total
--     from public.hr_insumos_comisiones
--    where company_id = :empresa and mes = :mes;
--
-- B) El signo NO se invirtió al guardar: para un perfil PnL, `pnl_crm` de la
--    cache tiene que ser IGUAL (mismo signo) al de la RPC.
--
--   select r.profile_id, r.pnl_crm as rpc, c.pnl_crm as cache
--     from public.hr_pnl_input_by_profile(:empresa, :mes) r
--     left join public.hr_insumos_comisiones c
--       on c.company_id = :empresa and c.mes = :mes and c.profile_id = r.profile_id
--    where r.pnl_crm is distinct from c.pnl_crm;      -- tiene que dar 0 filas
--
-- C) El merge por columna: con la cache llena, aplicar sólo el ND con una
--    lista vacía y p_pnl NULL dentro de una transacción que se deshace. El
--    PnL tiene que seguir intacto y el ND en NULL para todos.
--
--   begin;
--   select public.hr_insumos_comisiones_aplicar(:empresa, :mes,
--            '{"huerfano": null, "filas": []}'::jsonb, null);
--   select count(*) filter (where en_rpc_pnl) as pnl_intacto,   -- = antes
--          count(*) filter (where en_rpc_nd)  as nd_vaciado     -- = 0
--     from public.hr_insumos_comisiones
--    where company_id = :empresa and mes = :mes;
--   rollback;
-- ─────────────────────────────────────────────────────────────────────────────
