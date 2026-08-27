// ─────────────────────────────────────────────────────────────────────────────
// Las herramientas del asistente de IA — registro ÚNICO.
//
// QUÉ ES ESTO
// El modelo de Anthropic NUNCA toca la base. Lo único que puede hacer es pedir
// que se ejecute una de estas funciones, que corren en el servidor con el
// contexto del usuario que pregunta (resuelto UNA vez por `verifyAdminAuth`).
// El `company_id` sale del token y viaja en TODOS los filtros: con el admin
// client la RLS no cubre nada (regla del repo, §4.2), así que el
// `.eq('company_id', …)` explícito es lo único que separa a un bróker de otro.
//
// ── LA PUERTA ESTÁ DEL LADO DE AFUERA ─────────────────────────────────────
// El corte por módulo pasa DOS veces, y la primera es la que importa:
//
//   1. `toolsForContext()` filtra el array de herramientas ANTES de armar el
//      prompt. Si el que pregunta no tiene `risk`, la herramienta de riesgo ni
//      siquiera se le ofrece al modelo, así que ese dato no puede aparecer en
//      NINGÚN mensaje de la conversación.
//   2. `runTool()` vuelve a chequear en la ejecución y devuelve el texto de
//      "sin acceso" en vez de datos.
//
// El 2 es defensa en profundidad para el caso raro (un id de herramienta
// arrastrado de un turno viejo, un futuro call site que se saltee el filtro).
// Pero filtrar SÓLO en la respuesta sería una puerta con el candado del lado
// de adentro: el dato ya habría entrado al contexto del modelo, y lo que entra
// al contexto vuelve a salir tarde o temprano. Por eso hay un test que afirma
// que el dato prohibido no aparece en ninguno de los mensajes que se le mandan
// al modelo, no que "la respuesta no lo dice".
//
// Consecuencia deseada: un socio ve por el chat EXACTAMENTE lo que vería por
// pantalla. Leer lo decide el módulo (§4.1).
//
// ── LO QUE ESTAS HERRAMIENTAS NO HACEN ────────────────────────────────────
// No escriben. Ninguna. Por eso el módulo `assistant` alcanza con estar
// asignado y no exige además un rol de escritura: no hay nada que escribir.
// Tampoco consultan MT5 ni el CRM en vivo — leen las tablas espejo, igual que
// las pantallas (§3, G10: abrir el túnel cuesta ~3,5 s por visita).
//
// ── EL RECORTE SE AVISA SIEMPRE ───────────────────────────────────────────
// Cada herramienta devuelve un top N + totales, nunca 20.000 filas al
// contexto. Y cada recorte viaja con `truncado: true` y el total real, porque
// "un recorte silencioso es indistinguible de 'no hay más'" (§1.2). Si el
// modelo recibe 10 retiros sin saber que había 400, va a decir que había 10.
//
// ── null NO ES CERO ───────────────────────────────────────────────────────
// Donde el dato no existe se devuelve `null` y el system prompt obliga a
// decir "sin dato". Un cliente sin equity espejada NO tiene equity 0 (§1.3).
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canAccessAnyModule, moduleLabel, type ModuleKey } from '@/lib/modules';

/** Cliente de Supabase con service_role. Se INYECTA para poder testear sin red. */
export type AssistantDb = Pick<SupabaseClient, 'from' | 'rpc'>;

/**
 * Todo lo que una herramienta necesita saber del que pregunta. Se arma UNA vez
 * por request, en la ruta, a partir de `verifyAdminAuth` + la fila de
 * `companies`. Ninguna herramienta lo re-deriva: si cada una resolviera el
 * contexto por su cuenta tendríamos seis copias que se desincronizan, que es
 * el modo de falla número uno de este repo.
 */
export interface AssistantContext {
  db: AssistantDb;
  /** SIEMPRE del token. Nunca del input del modelo ni del cuerpo del request. */
  companyId: string;
  role: string;
  isSuperadmin: boolean;
  allowedModules: string[] | null;
  activeModules: string[] | null;
  businessModel: unknown;
  /** Idioma del usuario — sólo para el mensaje de "sin acceso". */
  locale: 'es' | 'en';
}

export interface AssistantTool {
  name: string;
  /** Módulos que habilitan la herramienta. Semántica OR, igual que las rutas. */
  modules: readonly ModuleKey[];
  definition: Anthropic.Tool;
  run: (input: Record<string, unknown>, ctx: AssistantContext) => Promise<unknown>;
}

// ── Topes ────────────────────────────────────────────────────────────────
// Medidos contra Vex Pro (2026-08-27): 21.196 usuarios espejados, 17.776
// depósitos, 12.061 retiros, 37.166 filas de premios de IB. Mandar eso al
// contexto costaría millones de tokens y el modelo leería peor, no mejor.
const TOP_FILAS = 15;
const MAX_COINCIDENCIAS = 5;
/** Tope duro de filas que se recorren para sumar un rango. Ver `sumarPaginado`. */
const MAX_FILAS_AGREGADO = 60_000;
const PAGINA = 1_000;

// ─────────────────────────────────────────────────────────────────────────
// El texto de "no tenés acceso". Es UNA sola función porque el system prompt
// le ordena al modelo repetirlo tal cual: si cada herramienta improvisara su
// frase, la persona vería a veces "no tenés acceso" y a veces "no hay datos",
// que significan cosas opuestas.
// ─────────────────────────────────────────────────────────────────────────
export function mensajeSinAcceso(
  modules: readonly ModuleKey[],
  locale: 'es' | 'en',
): { sin_acceso: true; mensaje: string } {
  const nombres = modules.map((m) => moduleLabel(m, locale)).join(' / ');
  return {
    sin_acceso: true,
    mensaje:
      locale === 'en'
        ? `You do not have access to the ${nombres} module, so I cannot look this up.`
        : `No tenés acceso al módulo ${nombres}, así que no puedo consultarlo.`,
  };
}

/** ¿Este usuario puede usar esta herramienta? Mismo helper que la API y la UI. */
export function puedeUsarHerramienta(tool: AssistantTool, ctx: AssistantContext): boolean {
  return canAccessAnyModule(tool.modules, {
    role: ctx.role,
    isSuperadmin: ctx.isSuperadmin,
    allowedModules: ctx.allowedModules,
    activeModules: ctx.activeModules,
    businessModel: ctx.businessModel,
  });
}

// ── Utilidades ───────────────────────────────────────────────────────────

/**
 * Limpia el texto que el MODELO pasa como criterio de búsqueda antes de
 * meterlo en un `ilike`. Dos motivos, los dos ya mordieron en este repo:
 *
 *   · `.or()` de PostgREST separa por coma: una coma en el término parte el
 *     filtro en dos y el segundo pedazo es sintaxis inválida → 400, o peor,
 *     un filtro distinto del que se quiso.
 *   · `%` y `_` son comodines de LIKE: un `%` suelto convierte "buscar a Ana"
 *     en "traer todo", y el recorte posterior lo haría pasar por resultado.
 */
export function sanearBusqueda(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[,()%_\\*"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** `YYYY-MM-DD` o null. Nunca `new Date(texto)`: depende de la zona del proceso (§3 G4). */
export function fechaIso(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** `YYYY-MM` o null. */
export function mesIso(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
}

function hoyUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function redondear2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RangoFechas {
  desde: string;
  hasta: string;
}

/**
 * Rango pedido por el modelo, con default de los últimos 30 días UTC. Si el
 * modelo manda el rango al revés se corrige en vez de fallar: pedir «de agosto
 * a julio» es un error de tipeo, no una pregunta distinta.
 */
export function resolverRango(input: Record<string, unknown>): RangoFechas {
  const DIA = 86_400_000;
  const hasta = fechaIso(input.hasta) ?? hoyUtc();
  const desde =
    fechaIso(input.desde) ?? new Date(Date.parse(hasta) - 29 * DIA).toISOString().slice(0, 10);
  return desde > hasta ? { desde: hasta, hasta: desde } : { desde, hasta };
}

interface Agregado {
  total: number;
  filas: number;
  truncado: boolean;
}

/**
 * Suma una columna paginando. PostgREST no da un `sum()` genérico y este repo
 * ya se quemó con `.limit()` compartido recortando en silencio (§1.2), así que
 * acá se pagina de verdad y se avisa cuando se llegó al tope.
 *
 * El tope existe porque el asistente responde en vivo: recorrer 300.000 filas
 * para contestar «¿cuánto depositaron este año?» dejaría a la persona mirando
 * un spinner. Con el tope alcanzado, `truncado: true` y el system prompt
 * obliga a decir que el número es parcial.
 */
async function sumarPaginado(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> },
  campo: string,
): Promise<Agregado> {
  let total = 0;
  let filas = 0;
  let desde = 0;
  for (;;) {
    const { data, error } = await build().range(desde, desde + PAGINA - 1);
    if (error) throw error;
    const lote = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of lote) {
      const v = r[campo];
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    filas += lote.length;
    if (lote.length < PAGINA) return { total: redondear2(total), filas, truncado: false };
    desde += PAGINA;
    if (desde >= MAX_FILAS_AGREGADO) {
      return { total: redondear2(total), filas, truncado: true };
    }
  }
}

/** Cuenta exacta sin traer filas (`head: true`). */
async function contar(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number | null> {
  const { count, error } = await q;
  if (error) throw error;
  return count ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. buscar_cliente
// ─────────────────────────────────────────────────────────────────────────

const buscarCliente: AssistantTool = {
  name: 'buscar_cliente',
  // `clients` O `risk`: el equipo de riesgo mira fichas de clientes todo el
  // día y no tiene por qué tener el módulo comercial.
  modules: ['clients', 'risk'],
  definition: {
    name: 'buscar_cliente',
    description:
      'Busca un cliente del bróker por email, username o nombre y devuelve su ficha: perfil del CRM, ' +
      'agregados (billetera, depósitos, retiros, KYC), actividad de trading en MetaTrader (cuentas, ' +
      'equity, última operación) y de dónde salió el dinero de su billetera. Usala siempre que la ' +
      'pregunta sea sobre UNA persona concreta. Si hay varias coincidencias devuelve la lista para ' +
      'que vuelvas a preguntar con el email exacto.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: {
          type: 'string',
          description: 'Email, username, nombre o apellido del cliente. Texto libre, mínimo 2 caracteres.',
        },
      },
      required: ['consulta'],
      additionalProperties: false,
    },
    strict: true,
  },
  async run(input, ctx) {
    const termino = sanearBusqueda(input.consulta);
    if (termino.length < 2) {
      return { error: 'La búsqueda necesita al menos 2 caracteres útiles.' };
    }
    const patron = `%${termino}%`;

    const { data, error } = await ctx.db
      .from('crm_user_snapshots')
      .select(
        'user_external_id, username, email, first_name, last_name, country, status, kyc_status, ' +
          'user_type, register_date, sponsor_username, sponsor_email, rank, pending_fee_debt, ' +
          'ib_program_name, language, synced_at',
      )
      .eq('company_id', ctx.companyId)
      .or(
        [
          `email.ilike.${patron}`,
          `username.ilike.${patron}`,
          `first_name.ilike.${patron}`,
          `last_name.ilike.${patron}`,
        ].join(','),
      )
      // +1 para poder DISTINGUIR "hay exactamente 5" de "hay más de 5". Sin
      // este truco el recorte sería indistinguible de "no hay más" (§1.2).
      .limit(MAX_COINCIDENCIAS + 1);
    if (error) throw error;

    const filas = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (filas.length === 0) {
      return { coincidencias: 0, mensaje: 'Ningún cliente coincide con esa búsqueda.' };
    }
    const hayMas = filas.length > MAX_COINCIDENCIAS;
    const perfiles = filas.slice(0, MAX_COINCIDENCIAS);

    // La ficha completa sólo para los 3 primeros: traerla para 5 son 15
    // consultas por pregunta y el modelo igual va a repreguntar por uno.
    const detallados = perfiles.slice(0, 3);
    const ids = detallados
      .map((p) => p.user_external_id)
      .filter((v): v is string => typeof v === 'string');

    const [agg, wallet, mt5] = await Promise.all([
      ids.length
        ? ctx.db
            .from('crm_customer_aggregates')
            .select(
              'user_external_id, email, wallet_balance, total_deposits, deposit_count, ' +
                'last_deposit_at, total_withdrawals, accounts_count, live_accounts_count, ' +
                'kyc_level, enabled_withdrawals, synced_at',
            )
            .eq('company_id', ctx.companyId)
            .in('user_external_id', ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? ctx.db
            .from('crm_wallet_sources')
            .select(
              'user_external_id, in_ib, in_social, in_propfirm, in_trading, in_p2p, in_deposit, ' +
                'in_other, out_p2p, in_returned',
            )
            .eq('company_id', ctx.companyId)
            .in('user_external_id', ids)
        : Promise.resolve({ data: [], error: null }),
      // mt5_account_activity se cruza por EMAIL: es la única llave común entre
      // MetaTrader y el CRM (no hay user_external_id del lado del bróker).
      detallados.length
        ? ctx.db
            .from('mt5_account_activity')
            .select(
              'login, email, group_name, is_demo, deals_count, account_balance, equity, ' +
                'first_deal_at, last_deal_at, synced_at',
            )
            .eq('company_id', ctx.companyId)
            .in(
              'email',
              detallados
                .map((p) => p.email)
                .filter((v): v is string => typeof v === 'string' && v !== ''),
            )
            .eq('is_demo', false)
            .limit(40)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of [agg, wallet, mt5]) if (r.error) throw r.error;

    const porId = <T extends { user_external_id?: unknown }>(rows: T[] | null, id: unknown) =>
      (rows ?? []).find((r) => r.user_external_id === id) ?? null;

    const fichas = detallados.map((p) => {
      const cuentas = ((mt5.data ?? []) as unknown as Array<Record<string, unknown>>).filter(
        (c) => typeof p.email === 'string' && c.email === p.email,
      );
      return {
        perfil: p,
        agregados: porId(agg.data as Array<{ user_external_id?: unknown }> | null, p.user_external_id),
        fuentes_billetera: porId(
          wallet.data as Array<{ user_external_id?: unknown }> | null,
          p.user_external_id,
        ),
        trading: {
          // `null` (no `0`) cuando no hay ninguna cuenta espejada: "no operó"
          // y "no lo sabemos" son datos distintos (§1.3).
          cuentas_live: cuentas.length || null,
          cuentas: cuentas.slice(0, 10),
          cuentas_truncadas: cuentas.length > 10,
          ultima_operacion:
            cuentas
              .map((c) => c.last_deal_at)
              .filter((v): v is string => typeof v === 'string')
              .sort()
              .at(-1) ?? null,
        },
      };
    });

    return {
      coincidencias: perfiles.length,
      hay_mas_coincidencias: hayMas,
      truncado: hayMas,
      fichas,
      otras_coincidencias: perfiles.slice(3).map((p) => ({
        email: p.email,
        username: p.username,
        user_external_id: p.user_external_id,
      })),
      nota_unidades:
        'El equity y el balance de MetaTrader van en la moneda del grupo de la cuenta. Las cuentas ' +
        'Cent están EN CENTAVOS: no se suman con las demás.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 2. metricas_broker
// ─────────────────────────────────────────────────────────────────────────

const metricasBroker: AssistantTool = {
  name: 'metricas_broker',
  modules: ['summary'],
  definition: {
    name: 'metricas_broker',
    description:
      'Métricas generales del bróker para un rango de fechas: depósitos completados, retiros ' +
      'aprobados, net deposit (depósitos − retiros), y cuántos clientes depositaron en el período ' +
      'contra el total de clientes registrados. Usala para preguntas de volumen del negocio.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha inicial UTC, formato YYYY-MM-DD.' },
        hasta: { type: 'string', description: 'Fecha final UTC, formato YYYY-MM-DD.' },
      },
      required: ['desde', 'hasta'],
      additionalProperties: false,
    },
    strict: true,
  },
  async run(input, ctx) {
    const { desde, hasta } = resolverRango(input);
    const desdeTs = `${desde}T00:00:00Z`;
    // El fin del rango es EXCLUSIVO sobre el día siguiente: con `lte` al
    // 'T23:59:59' se pierden los movimientos del último segundo del día.
    const hastaTs = `${new Date(Date.parse(hasta) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`;

    // Importes: `amount_paid` para depósitos (lo que llegó) y
    // `requested_amount` para retiros (lo que sale de la billetera). NO
    // `deposit_value`, que está corrupto — máximo 1,4e16 (§3.1).
    const [dep, ret, totalClientes] = await Promise.all([
      sumarPaginado(
        () =>
          ctx.db
            .from('crm_deposits')
            .select('amount_paid')
            .eq('company_id', ctx.companyId)
            .eq('status_norm', 'completed')
            .gte('deposit_at', desdeTs)
            .lt('deposit_at', hastaTs)
            .order('id') as never,
        'amount_paid',
      ),
      sumarPaginado(
        () =>
          ctx.db
            .from('crm_withdrawals')
            .select('requested_amount')
            .eq('company_id', ctx.companyId)
            .eq('status_norm', 'approved')
            .gte('requested_at', desdeTs)
            .lt('requested_at', hastaTs)
            .order('id') as never,
        'requested_amount',
      ),
      contar(
        ctx.db
          .from('crm_user_snapshots')
          .select('user_external_id', { count: 'exact', head: true })
          .eq('company_id', ctx.companyId) as never,
      ),
    ]);

    // Clientes que depositaron en el rango. Se cuentan distintos sobre la
    // misma página que ya se recorre para sumar; traerlos aparte sería un
    // segundo barrido del mismo índice.
    const { data: depUsers, error: depErr } = await ctx.db
      .from('crm_deposits')
      .select('user_external_id')
      .eq('company_id', ctx.companyId)
      .eq('status_norm', 'completed')
      .gte('deposit_at', desdeTs)
      .lt('deposit_at', hastaTs)
      .limit(MAX_FILAS_AGREGADO);
    if (depErr) throw depErr;
    const activos = new Set(
      ((depUsers ?? []) as Array<{ user_external_id: string | null }>)
        .map((r) => r.user_external_id)
        .filter((v): v is string => !!v),
    ).size;

    return {
      rango: { desde, hasta, zona: 'UTC' },
      depositos: { total: dep.total, operaciones: dep.filas, truncado: dep.truncado },
      retiros: { total: ret.total, operaciones: ret.filas, truncado: ret.truncado },
      net_deposit: redondear2(dep.total - ret.total),
      clientes: {
        con_deposito_en_el_rango: activos,
        registrados_total: totalClientes,
        // `null` cuando no se pudo contar el total: sin él, "sin actividad" no
        // se puede calcular y decir 0 sería inventar.
        sin_deposito_en_el_rango:
          typeof totalClientes === 'number' ? Math.max(0, totalClientes - activos) : null,
      },
      truncado: dep.truncado || ret.truncado,
      nota:
        'Depósitos = status completado, importe amount_paid (lo que realmente llegó). Retiros = ' +
        'status aprobado, importe requested_amount (lo que sale de la billetera). Cortes UTC. Los ' +
        'clientes registrados incluyen todo el histórico espejado, no sólo el rango.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 3. riesgo_retiros
// ─────────────────────────────────────────────────────────────────────────

const riesgoRetiros: AssistantTool = {
  name: 'riesgo_retiros',
  modules: ['risk'],
  definition: {
    name: 'riesgo_retiros',
    description:
      'La cola de retiros pendientes con su score de riesgo, y la cola de retiros de prop firm con ' +
      'el veredicto de la revisión automática. Usala para "¿qué retiros hay para revisar?", "¿cuál ' +
      'es el más riesgoso?", "¿cuánto dinero hay pendiente de salir?".',
    input_schema: {
      type: 'object',
      properties: {
        limite: {
          type: 'integer',
          description: `Cuántos retiros devolver, de 1 a ${TOP_FILAS}. Se ordenan por importe pedido, de mayor a menor.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const limite = Math.min(
      TOP_FILAS,
      Math.max(1, typeof input.limite === 'number' ? Math.trunc(input.limite) : TOP_FILAS),
    );

    const [pend, total, propfirm] = await Promise.all([
      ctx.db
        .from('crm_withdrawals')
        .select(
          'external_id, username, email, requested_amount, coin, network, processor, ' +
            'status_norm, requested_at',
        )
        .eq('company_id', ctx.companyId)
        .eq('status_norm', 'pending')
        .order('requested_amount', { ascending: false, nullsFirst: false })
        .limit(limite),
      contar(
        ctx.db
          .from('crm_withdrawals')
          .select('external_id', { count: 'exact', head: true })
          .eq('company_id', ctx.companyId)
          .eq('status_norm', 'pending') as never,
      ),
      ctx.db
        .from('propfirm_withdrawal_queue')
        .select(
          'withdraw_id, login, username, user_email, program_name, requested_amount, ' +
            'requested_date, status, profit_share_pct, review_outcome, review_violations, ' +
            'review_unverifiable, reviewed_at',
        )
        .eq('company_id', ctx.companyId)
        .order('requested_date', { ascending: false, nullsFirst: false })
        .limit(limite),
    ]);
    if (pend.error) throw pend.error;
    if (propfirm.error) throw propfirm.error;

    const filas = (pend.data ?? []) as unknown as Array<Record<string, unknown>>;
    const ids = filas
      .map((r) => r.external_id)
      .filter((v): v is string => typeof v === 'string');

    // El score vive en una tabla aparte porque lo calcula el cron. Un retiro
    // SIN fila de review no tiene score 0: no se le calculó todavía.
    const { data: reviews, error: revErr } = ids.length
      ? await ctx.db
          .from('withdrawal_reviews')
          .select('withdrawal_external_id, score, score_band, decision, decided_by_name, decided_at, notes')
          .eq('company_id', ctx.companyId)
          .in('withdrawal_external_id', ids)
      : { data: [], error: null };
    if (revErr) throw revErr;

    const porExt = new Map(
      ((reviews ?? []) as unknown as Array<Record<string, unknown>>).map((r) => [
        r.withdrawal_external_id,
        r,
      ]),
    );

    return {
      cola_billetera: {
        pendientes_total: total,
        mostrados: filas.length,
        truncado: typeof total === 'number' && total > filas.length,
        retiros: filas.map((w) => {
          const rev = porExt.get(w.external_id) ?? null;
          return {
            ...w,
            score: rev ? (rev as Record<string, unknown>).score : null,
            banda: rev ? (rev as Record<string, unknown>).score_band : null,
            decision: rev ? (rev as Record<string, unknown>).decision : null,
            revisado_por: rev ? (rev as Record<string, unknown>).decided_by_name : null,
            sin_score_calculado: !rev,
          };
        }),
      },
      cola_propfirm: {
        mostrados: (propfirm.data ?? []).length,
        retiros: propfirm.data ?? [],
      },
      nota_score:
        'El score NUNCA decide: es orientación para mirar primero lo que más lo merece. Aprobar o ' +
        'rechazar lo firma una persona, y el dashboard no ejecuta el retiro en el CRM nunca. ' +
        'Un retiro sin fila de revisión no tiene score 0: no se le calculó todavía.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 4. exposicion
// ─────────────────────────────────────────────────────────────────────────

/** Última `snapshot_at` de una tabla de fotos. null = nunca se sincronizó. */
async function ultimaFoto(
  db: AssistantDb,
  tabla: string,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from(tabla)
    .select('snapshot_at')
    .eq('company_id', companyId)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const fila = (data ?? [])[0] as { snapshot_at?: string } | undefined;
  return fila?.snapshot_at ?? null;
}

const exposicion: AssistantTool = {
  name: 'exposicion',
  modules: ['risk'],
  definition: {
    name: 'exposicion',
    description:
      'La última foto del riesgo vivo en MetaTrader: exposición por símbolo (lotes netos, flotante), ' +
      'las cuentas con menos margen libre, y el PNL abierto y cerrado del día. El dato puede tener ' +
      'hasta 15 minutos; la hora exacta viene en la respuesta.',
    input_schema: {
      type: 'object',
      properties: {
        limite: {
          type: 'integer',
          description: `Cuántas filas por sección, de 1 a ${TOP_FILAS}.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const limite = Math.min(
      TOP_FILAS,
      Math.max(1, typeof input.limite === 'number' ? Math.trunc(input.limite) : TOP_FILAS),
    );

    const [tExp, tMar, tPnl] = await Promise.all([
      ultimaFoto(ctx.db, 'mt5_exposure_snapshots', ctx.companyId),
      ultimaFoto(ctx.db, 'mt5_margin_risk_snapshots', ctx.companyId),
      ultimaFoto(ctx.db, 'mt5_pnl_snapshots', ctx.companyId),
    ]);

    const [exp, mar, pnl] = await Promise.all([
      tExp
        ? ctx.db
            .from('mt5_exposure_snapshots')
            .select('family, symbol, positions, accounts, long_lots, short_lots, net_lots, floating, storage, unit, is_virtual')
            .eq('company_id', ctx.companyId)
            .eq('snapshot_at', tExp)
            // Se ordena por POSICIONES y no por flotante: el flotante no es
            // comparable entre familias (Cent en centavos, PropFirm virtual),
            // así que ordenar por él mezclaría manzanas con centavos.
            .order('positions', { ascending: false, nullsFirst: false })
            .limit(limite)
        : Promise.resolve({ data: [], error: null }),
      tMar
        ? ctx.db
            .from('mt5_margin_risk_snapshots')
            .select('login, email, family, group_name, equity, balance, margin, margin_free, margin_level, floating, unit, is_virtual')
            .eq('company_id', ctx.companyId)
            .eq('snapshot_at', tMar)
            .not('margin_level', 'is', null)
            .order('margin_level', { ascending: true })
            .limit(limite)
        : Promise.resolve({ data: [], error: null }),
      tPnl
        ? ctx.db
            .from('mt5_pnl_snapshots')
            .select('utc_day, category, currency, open_positions, open_accounts, open_pnl, open_swap, closed_deals, closed_accounts, closed_pnl, closed_swap, closed_commission, accounts_outside_crm')
            .eq('company_id', ctx.companyId)
            .eq('snapshot_at', tPnl)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of [exp, mar, pnl]) if (r.error) throw r.error;

    if (!tExp && !tMar && !tPnl) {
      return {
        sin_dato: true,
        mensaje:
          'Todavía no hay ninguna foto de exposición sincronizada para esta empresa. No es que la ' +
          'exposición sea cero: no se sabe.',
      };
    }

    return {
      tomado_a: { exposicion: tExp, margen: tMar, pnl: tPnl },
      exposicion_por_simbolo: exp.data ?? [],
      cuentas_con_menos_margen: mar.data ?? [],
      pnl_del_dia: pnl.data ?? [],
      truncado: true,
      nota_unidades:
        'DOCTRINA DE UNIDADES, no negociable: el dinero viaja con su unidad y NUNCA se suma entre ' +
        'familias. Las cuentas Cent están EN CENTAVOS (sumarlas dio 101 M contra 7,6 M reales) y las ' +
        'PropFirm llevan capital virtual de desafío. Los conteos de posiciones y los lotes SÍ se ' +
        'pueden sumar. Cada fila trae su `unit`; informá los importes por familia, jamás un total.',
      nota_alcance:
        'Sólo cuentas vinculadas al CRM: en MetaTrader hay ~1.140 cuentas de prueba que operan igual ' +
        'que un cliente. Por eso los totales de PNL y los de exposición no tienen por qué cuadrar. ' +
        'Las filas mostradas son un top, no la lista completa.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 5. rrhh
// ─────────────────────────────────────────────────────────────────────────

const rrhh: AssistantTool = {
  name: 'rrhh',
  modules: ['hr'],
  definition: {
    name: 'rrhh',
    description:
      'Recursos Humanos y equipo comercial: perfiles activos (BDM, heads, sales) con su negociación, ' +
      'llamados de atención cargados, el net deposit atribuido a cada perfil en un mes, y la ' +
      'producción de los IB (lotes, comisión pagada, PNL atribuido). Usala para preguntas sobre ' +
      'personas del equipo, no sobre clientes.',
    input_schema: {
      type: 'object',
      properties: {
        mes: {
          type: 'string',
          description: 'Mes a analizar en formato YYYY-MM. Por defecto, el mes en curso.',
        },
        limite: { type: 'integer', description: `Filas por sección, de 1 a ${TOP_FILAS}.` },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const mes = mesIso(input.mes) ?? hoyUtc().slice(0, 7);
    const primerDia = `${mes}-01`;
    const limite = Math.min(
      TOP_FILAS,
      Math.max(1, typeof input.limite === 'number' ? Math.trunc(input.limite) : TOP_FILAS),
    );

    const [perfiles, warnings, nd, ib] = await Promise.all([
      ctx.db
        .from('commercial_profiles')
        .select(
          'id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, ' +
            'fixed_salary, status, hire_date, termination_date',
        )
        .eq('company_id', ctx.companyId)
        .eq('status', 'active')
        .order('name')
        .limit(120),
      ctx.db
        .from('hr_warnings')
        .select('profile_id, month, motive, detail, created_by_name, created_at')
        .eq('company_id', ctx.companyId)
        .order('created_at', { ascending: false })
        .limit(limite),
      // RPC: el rollup de net deposit por perfil vive en SQL porque cruza la
      // estructura comercial con los depósitos del CRM. Duplicarlo acá sería
      // una segunda copia de la fórmula.
      ctx.db.rpc('hr_net_deposit_by_profile', {
        p_company_id: ctx.companyId,
        p_month: primerDia,
      }),
      ctx.db
        .from('crm_ib_reward_daily')
        .select('ib_user_id, lots, commission, pnl, rewards_count, day')
        .eq('company_id', ctx.companyId)
        .gte('day', primerDia)
        .lt(
          'day',
          `${new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 1))
            .toISOString()
            .slice(0, 10)}`,
        )
        .limit(MAX_FILAS_AGREGADO),
    ]);
    for (const r of [perfiles, warnings, nd, ib]) if (r.error) throw r.error;

    // Producción de IB: se agrupa acá porque la tabla es diaria (37.166 filas
    // en Vex Pro). Mandar el diario al contexto sería absurdo.
    const porIb = new Map<string, { lots: number; commission: number; pnl: number; dias: number }>();
    for (const raw of (ib.data ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = typeof raw.ib_user_id === 'string' ? raw.ib_user_id : null;
      if (!id) continue;
      const acc = porIb.get(id) ?? { lots: 0, commission: 0, pnl: 0, dias: 0 };
      acc.lots += Number(raw.lots) || 0;
      acc.commission += Number(raw.commission) || 0;
      acc.pnl += Number(raw.pnl) || 0;
      acc.dias += 1;
      porIb.set(id, acc);
    }
    const ibTop = [...porIb.entries()]
      .map(([ib_user_id, v]) => ({
        ib_user_id,
        lotes: redondear2(v.lots),
        comision_pagada: redondear2(v.commission),
        pnl_atribuido: redondear2(v.pnl),
        dias_con_actividad: v.dias,
      }))
      .sort((a, b) => b.comision_pagada - a.comision_pagada)
      .slice(0, limite);

    const ndFilas = (nd.data ?? []) as unknown as Array<Record<string, unknown>>;
    const nombrePorId = new Map(
      ((perfiles.data ?? []) as unknown as Array<Record<string, unknown>>).map((p) => [p.id, p.name]),
    );

    return {
      mes,
      perfiles_activos: {
        total: (perfiles.data ?? []).length,
        // El listado completo se manda sólo si es corto; si no, un top y el
        // total, con el aviso de recorte.
        perfiles: (perfiles.data ?? []).slice(0, limite),
        truncado: (perfiles.data ?? []).length > limite,
      },
      net_deposit_por_perfil: ndFilas
        .map((r) => ({
          perfil: nombrePorId.get(r.profile_id) ?? null,
          profile_id: r.profile_id,
          net_deposit: r.net,
          clientes: r.clients,
        }))
        .sort((a, b) => Number(b.net_deposit ?? 0) - Number(a.net_deposit ?? 0))
        .slice(0, limite),
      net_deposit_truncado: ndFilas.length > limite,
      llamados_de_atencion: (warnings.data ?? []).map((w) => ({
        ...(w as Record<string, unknown>),
        perfil: nombrePorId.get((w as Record<string, unknown>).profile_id) ?? null,
      })),
      produccion_ib: ibTop,
      produccion_ib_truncada: porIb.size > ibTop.length,
      produccion_ib_ibs_distintos: porIb.size,
      nota_pnl:
        'El PNL de la producción de IB es PNL ATRIBUIDO a la red del IB, no ganancia del IB ni del ' +
        'bróker. Decilo así siempre que lo menciones.',
      nota_comisiones:
        'Los porcentajes del perfil son la negociación, no lo cobrado. Lo que efectivamente cobra una ' +
        'persona en un mes sale del módulo de Comisiones, que aplica tiers, deuda arrastrada y ' +
        'diferencial de head: no lo calcules vos multiplicando el porcentaje.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 6. finanzas
// ─────────────────────────────────────────────────────────────────────────

const finanzas: AssistantTool = {
  name: 'finanzas',
  // Semántica OR para poder ofrecer la herramienta, pero ADENTRO cada sección
  // se vuelve a chequear contra su propio módulo: alguien con `expenses` y sin
  // `income` recibe los egresos y, en el lugar de los ingresos, el texto de
  // "sin acceso". Devolver las tres secciones porque tiene una sería
  // exactamente la fuga que el gate existe para evitar.
  modules: ['expenses', 'income', 'balances'],
  definition: {
    name: 'finanzas',
    description:
      'Finanzas del período contable: egresos (total, pagado, pendiente y por categoría), ingresos ' +
      '(facturado y cobrado) y balances por canal. Devuelve sólo las secciones que el usuario tiene ' +
      'habilitadas. Usala para "¿cuánto gastamos en X?", "¿cuánto facturamos?", "¿cómo cerró el mes?".',
    input_schema: {
      type: 'object',
      properties: {
        periodo: {
          type: 'string',
          description: 'Período contable en formato YYYY-MM. Por defecto, el más reciente cargado.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const pedido = mesIso(input.periodo);

    // El período se resuelve contra `periods` y no contra fechas sueltas: la
    // contabilidad de este dashboard vive por período, y un egreso pertenece
    // al período en el que se cargó aunque su `expense_date` diga otra cosa.
    let q = ctx.db
      .from('periods')
      .select('id, year, month, label, is_closed')
      .eq('company_id', ctx.companyId);
    if (pedido) {
      q = q.eq('year', Number(pedido.slice(0, 4))).eq('month', Number(pedido.slice(5, 7)));
    }
    const { data: perData, error: perErr } = await q
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(1);
    if (perErr) throw perErr;
    const periodo = (perData ?? [])[0] as
      | { id: string; year: number; month: number; label: string | null; is_closed: boolean }
      | undefined;
    if (!periodo) {
      return {
        sin_dato: true,
        mensaje: pedido
          ? `No existe el período ${pedido} para esta empresa.`
          : 'Esta empresa todavía no tiene ningún período contable cargado.',
      };
    }

    const puede = (m: ModuleKey) =>
      canAccessAnyModule([m], {
        role: ctx.role,
        isSuperadmin: ctx.isSuperadmin,
        allowedModules: ctx.allowedModules,
        activeModules: ctx.activeModules,
        businessModel: ctx.businessModel,
      });

    const [egr, ing, bal] = await Promise.all([
      puede('expenses')
        ? ctx.db
            .from('expenses')
            .select('concept, amount, paid, pending, category, is_fixed, expense_date')
            .eq('company_id', ctx.companyId)
            .eq('period_id', periodo.id)
            .limit(MAX_FILAS_AGREGADO)
        : Promise.resolve({ data: null, error: null }),
      puede('income')
        ? ctx.db
            .from('income_lines')
            .select('concept, client, amount, received, pending, category, income_date')
            .eq('company_id', ctx.companyId)
            .eq('period_id', periodo.id)
            .limit(MAX_FILAS_AGREGADO)
        : Promise.resolve({ data: null, error: null }),
      puede('balances')
        ? ctx.db
            .from('channel_balances')
            .select('snapshot_date, channel_key, amount, source, notes')
            .eq('company_id', ctx.companyId)
            .order('snapshot_date', { ascending: false })
            .limit(60)
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [egr, ing, bal]) if (r.error) throw r.error;

    const agrupar = (
      filas: Array<Record<string, unknown>>,
      campoTotal: string,
      campoCobrado: string,
    ) => {
      const porCat = new Map<string, number>();
      let total = 0;
      let cobrado = 0;
      for (const f of filas) {
        const monto = Number(f[campoTotal]) || 0;
        total += monto;
        cobrado += Number(f[campoCobrado]) || 0;
        const cat = typeof f.category === 'string' && f.category ? f.category : 'sin categoría';
        porCat.set(cat, (porCat.get(cat) ?? 0) + monto);
      }
      return {
        total: redondear2(total),
        cobrado_o_pagado: redondear2(cobrado),
        pendiente: redondear2(total - cobrado),
        lineas: filas.length,
        por_categoria: [...porCat.entries()]
          .map(([categoria, monto]) => ({ categoria, monto: redondear2(monto) }))
          .sort((a, b) => b.monto - a.monto)
          .slice(0, TOP_FILAS),
        categorias_truncadas: porCat.size > TOP_FILAS,
      };
    };

    // Última foto por canal: `channel_balances` es una serie diaria, así que
    // "el balance" es la fila más reciente de CADA canal, no la suma.
    const balFilas = (bal.data ?? []) as unknown as Array<Record<string, unknown>>;
    const ultimoPorCanal = new Map<string, Record<string, unknown>>();
    for (const f of balFilas) {
      const k = String(f.channel_key ?? '');
      if (!ultimoPorCanal.has(k)) ultimoPorCanal.set(k, f);
    }

    return {
      periodo: {
        etiqueta: periodo.label ?? `${periodo.year}-${String(periodo.month).padStart(2, '0')}`,
        year: periodo.year,
        month: periodo.month,
        cerrado: periodo.is_closed,
      },
      egresos: egr.data
        ? agrupar(egr.data as unknown as Array<Record<string, unknown>>, 'amount', 'paid')
        : mensajeSinAcceso(['expenses'], ctx.locale),
      ingresos: ing.data
        ? agrupar(ing.data as unknown as Array<Record<string, unknown>>, 'amount', 'received')
        : mensajeSinAcceso(['income'], ctx.locale),
      balances_por_canal: bal.data
        ? { ultima_foto_por_canal: [...ultimoPorCanal.values()] }
        : mensajeSinAcceso(['balances'], ctx.locale),
      nota:
        'Los egresos van en base DEVENGADO (`amount`); `paid` es la caja. La distinción importa: en ' +
        'las empresas con modelo "company" la cadena de distribución usa la caja y en los brókers el ' +
        'devengado. No mezcles los dos en un mismo total.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// El registro. UNA sola lista: agregar una herramienta es agregar una fila.
// ─────────────────────────────────────────────────────────────────────────

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  buscarCliente,
  metricasBroker,
  riesgoRetiros,
  exposicion,
  rrhh,
  finanzas,
];

/**
 * Las herramientas que ESTE usuario puede usar. Es lo que se manda en el
 * `tools` del request: lo que no está acá no existe para el modelo, así que
 * su dato no puede entrar a la conversación.
 */
export function toolsForContext(ctx: AssistantContext): AssistantTool[] {
  return ASSISTANT_TOOLS.filter((t) => puedeUsarHerramienta(t, ctx));
}

/**
 * Ejecuta una herramienta por nombre. Segundo chequeo del módulo (defensa en
 * profundidad, ver cabecera) y captura de errores: un fallo de base tiene que
 * volver como resultado de herramienta, no tumbar el stream — el modelo puede
 * contestar «no pude consultar X» y seguir con el resto.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AssistantContext,
): Promise<unknown> {
  const tool = ASSISTANT_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `La herramienta "${name}" no existe.` };
  if (!puedeUsarHerramienta(tool, ctx)) return mensajeSinAcceso(tool.modules, ctx.locale);
  try {
    return await tool.run(input, ctx);
  } catch (err) {
    // NUNCA el mensaje crudo del motor al modelo (y de ahí a la pantalla):
    // puede llevar nombres de columnas, la query entera o parte de la conexión.
    console.warn(`[assistant] herramienta ${name} falló:`, err instanceof Error ? err.message : err);
    return { error: `No se pudo consultar ${name} en este momento.` };
  }
}
