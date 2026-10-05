-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 129 — Master IB dentro de la línea de un BDM + % manual por mes
--
-- (El número se eligió AL MERGEAR, como manda el §0: hoy 2026-09-06 hubo DOS
--  colisiones con la rama de Kevin —la 128 nació como 125 y la cabecera lo
--  cuenta—, así que antes de aplicar esto: `git fetch` y
--  `ls supabase/migration-*.sql | tail -3`. Si 129 ya está tomado, se renumera
--  y se avisa en el commit; los dos ALTER son idempotentes.)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. `commercial_profiles.is_master_ib`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── El caso real (2026-09-06) ───────────────────────────────────────────────
-- Ana García (BDM, ana.garcia@mail.vexprofx.com) tiene en su línea del CRM al
-- usuario `millonariosteam2018`, que YA tiene perfil comercial propio: Jose
-- Emanuel Hernandez Alvarez (millonariosteam2018@gmail.com, grupo PnL
-- Especial) y hasta hoy sin `head_id`. Es un MASTER IB: no es un BDM de la
-- fuerza de ventas, es un socio con su propia red colgando de la línea de Ana.
--
-- Mientras esa red se le cuenta a Ana, el ND automático de Ana (agosto 2026:
-- 278.130,66) incluye 281.168,49 producidos por 3.511 usuarios que no son
-- suyos, y esa plata se paga DOS veces: una a Ana por net deposit y otra al
-- master por su propio esquema.
--
-- ── Cómo se corta, y por qué NO se toca la RPC ─────────────────────────────
-- `hr_net_deposit_by_profile` (migración 121, reescrita en la 123) arma sus
-- ROOTS con los "perfiles con rol":
--
--     where p0.head_id is not null
--        or exists (select 1 from p0 c where c.head_id = p0.id)
--
-- O sea: colgar a Jose Emanuel de Ana (`head_id` = perfil de Ana) lo convierte
-- por sí solo en un root, y el árbol del CRM deja de subirle su subred a Ana —
-- exactamente el mecanismo que ya usan los heads. LA RPC NO SE MODIFICA: esta
-- feature no inventa un corte nuevo, aprovecha el que ya existe. El único
-- cálculo medido:
--
--     ND automático del master (su subred)   =  281.168,49   (3.511 usuarios)
--     ND automático de Ana, agosto, hoy      =  278.130,66
--     ND propio de Ana tras el corte         =   −3.037,83   (= own del rollup)
--
-- ── Entonces, ¿para qué hace falta la columna? ─────────────────────────────
-- Para que colgar al master NO convierta a Ana en "sub-head" a los ojos de
-- /comisiones. Esa pantalla decide en dos lugares (`isSubHead`, y el
-- `isSubWithTeam` del guardado por equipos) con la forma «¿tiene hijos?», y un
-- hijo master la haría perder los tramos de % por volumen y le cambiaría la
-- fila que se guarda bajo su head. `is_master_ib = true` hace que ese hijo NO
-- cuente como equipo. Es la MISMA idea que `nd_pct_fixed` (128): una excepción
-- explícita por perfil, con default que deja a todos como estaban.
--
-- Lo que NO cambia el flag: la RPC (ver arriba), el selector de grupos de
-- /comisiones (un perfil con un master colgando SÍ tiene que poder elegirse
-- como grupo, igual que un head, para ver la fila del master), y la lectura
-- del ND propio del líder de un grupo (`net_deposit_accumulated`), que tiene
-- que seguir emparejada con lo que escribe el guardado.
--
-- MEDIDO HOY, antes de tocar nada: NINGÚN BDM de Vex Pro tiene hijos en
-- `commercial_profiles` (todos los padres son head/sales_manager). Por eso el
-- cambio de heurística de /comisiones no puede mover a nadie existente: con
-- `is_master_ib = false` en todas las filas —el default— el comportamiento es
-- bit a bit el de hoy.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. `commercial_monthly_results.pct_override`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El % de comisión de un BDM por net deposit sale hoy de tres reglas
-- encadenadas: los tramos por volumen (BDM_PCT_TIERS, piso nunca techo), la
-- excepción `nd_pct_fixed` (128) y el `net_deposit_pct` del perfil. Las tres
-- son configuración PERMANENTE. El dueño pidió (2026-09-06) poder fijar el %
-- de UN MES sin tocar el acuerdo: "este mes a fulano le pagamos 3", o incluso
-- 0 (no se le paga comisión este mes) sin borrarle el % del perfil.
--
-- `pct_override` es ese número, y vive en la fila del mes porque es un dato
-- del mes, no del perfil.
--
--   · NULL  = automático. Manda la lógica de siempre, intacta.
--   · 0     = CERO DE VERDAD: ese mes no cobra comisión.
--   · n     = ese % pisa tramos, `nd_pct_fixed` y `net_deposit_pct`.
--
-- NULL ≠ 0 (§1.3), y por eso la columna es `numeric` sin default y sin NOT
-- NULL: un default 0 haría que TODA la empresa dejara de cobrar comisión en
-- silencio, que es exactamente el modo de falla del §1.2 (número plausible,
-- ninguna excepción). En la pantalla, el input vacío guarda NULL; un 0
-- tecleado guarda 0.
--
-- Solo aplica al grupo NET DEPOSIT (tabs Equipos e Individual). El grupo PnL y
-- el PnL Especial tienen su propio % (`pnl_pct`) y no se pidió tocarlos.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.commercial_profiles
  add column if not exists is_master_ib boolean not null default false;

comment on column public.commercial_profiles.is_master_ib is
  'true = el perfil es un Master IB dentro de la linea de un BDM: su subred se '
  'corta del ND del BDM padre por el mecanismo de roots de '
  'hr_net_deposit_by_profile (que NO cambia, solo hace falta setear head_id) y '
  'ademas NO cuenta como equipo en /comisiones, asi que el BDM padre no se '
  'vuelve sub-head (conserva sus tramos de % por volumen). false (default) = '
  'un hijo normal, todo como estaba. Caso que lo motivo: Jose Emanuel '
  'Hernandez Alvarez (millonariosteam2018) colgando de Ana Garcia, 2026-09-06.';

alter table public.commercial_monthly_results
  add column if not exists pct_override numeric;

comment on column public.commercial_monthly_results.pct_override is
  '% de comision MANUAL de ese mes para el grupo Net Deposit: pisa los tramos '
  'por volumen, nd_pct_fixed y el net_deposit_pct del perfil, y SOLO ese mes. '
  'NULL = automatico (la logica de siempre); 0 es un valor valido y significa '
  'que ese mes no se paga comision. NULL != 0 (regla 1.3 del repo). No aplica '
  'al grupo PnL ni al PnL Especial, que usan pnl_pct.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano; los dos pasos, en este orden):
--
-- ── (1) NADA CAMBIA con solo aplicar la migración ──────────────────────────
-- ANTES de configurar ningún master y ningún %, /comisiones tiene que dar el
-- mismo número que ayer. El control es el grupo de Hugo Ortiz en AGOSTO 2026:
--
--     total del grupo (ND del mes)  =  688.474,46   EXACTO
--
-- Si ese número se movió, algo del cambio de heurística no era inocuo y hay
-- que parar: con `is_master_ib = false` en todas las filas no puede moverse ni
-- un centavo. Y en la base:
--
--   select count(*) filter (where is_master_ib) as masters,
--          count(*)                             as perfiles
--     from commercial_profiles
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36';
--   -- masters = 0
--
--   select count(*) filter (where pct_override is not null) as con_override
--     from commercial_monthly_results
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36';
--   -- con_override = 0
--
-- ── (2) DESPUÉS de colgar al master de Ana ─────────────────────────────────
-- En «Editar Perfil Comercial» de Jose Emanuel: marcar «Master IB» y elegir a
-- Ana García como Supervisor (el selector lista BDMs solo con el flag puesto).
-- Después, agosto 2026:
--
--     fila del master (su subred)   ≈  281.168,49   (3.511 usuarios)
--     fila de Ana (su producción)   ≈   −3.037,83
--     suma de las dos               ≈  278.130,66   (el ND que Ana tenía sola)
--
-- Dónde se mira cada una: el ND de Ana, en /comisiones (tab Individual, o su
-- fila en el grupo de Hugo). La subred del master, en el ÁRBOL de /rrhh →
-- Net Deposit: en /comisiones el campo de Jose Emanuel muestra su PnL, no su
-- net deposit, porque tiene `pnl_pct` cargado y ése es su esquema de cobro —
-- si mañana un master cobrara por net deposit, su fila usaría este mismo
-- número (su `total`, como cualquier root).
--
-- «≈» y no «=»: el CRM sigue vivo y un depósito que se concilia tarde mueve
-- los decimales. Lo que tiene que cuadrar exacto es la SUMA contra el ND que
-- Ana mostraba antes del cambio, tomados el mismo día.
--
--   select p.name, p.is_master_ib, p.head_id
--     from commercial_profiles p
--    where p.email in ('millonariosteam2018@gmail.com',
--                      'ana.garcia@mail.vexprofx.com');
-- ─────────────────────────────────────────────────────────────────────────────
