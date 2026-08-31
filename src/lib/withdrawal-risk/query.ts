// ─────────────────────────────────────────────────────────────────────────────
// Acceso a datos del módulo de Revisión de Retiros.
//
// Acá vive TODO el I/O: `features.ts` y `score.ts` son puros a propósito, así
// que este archivo es el único que sabe que existe Supabase. Lee sólo del
// ESPEJO (crm_withdrawals / crm_deposits / crm_user_snapshots, migración 088);
// jamás toca el CRM.
//
// ── POR QUÉ NO HAY UNA CONSULTA SQL AGREGADA POR RETIRO ─────────────────────
// Lo natural sería un LATERAL por fila que sume los movimientos anteriores a
// `requested_at`. PostgREST no expone laterales y no podemos crear una RPC
// (esta fase no toca migraciones). La alternativa ingenua —tres consultas por
// retiro— sería N+1: con 26 pendientes son 78 viajes.
//
// El patrón que se usa acá es "dos consultas y agregar en memoria":
//   1. una consulta trae los retiros pendientes (≤ unas decenas),
//   2. se junta el set de `user_external_id` (≤ 26 usuarios distintos),
//   3. DOS consultas más traen los movimientos de ESE set de usuarios,
//      pidiendo sólo las tres columnas que hacen falta (usuario, importe,
//      fecha) — filas livianas, y ambas pegan contra los índices
//      idx_crm_deposits_user / idx_crm_withdrawals_user,
//   4. el corte punto-en-el-tiempo se aplica en `computeFeatures`, que ya
//      filtra por fecha.
// Total: 4 consultas para la cola entera, independientemente de su tamaño.
//
// El límite implícito de PostgREST (1.000 filas) mordería en silencio a un
// cliente con mucho historial, así que todas las lecturas grandes pasan por
// `fetchAllPages`.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeFeatures, type WithdrawalFeatures } from './features';
import {
  scoreWithdrawal,
  informativeNotes,
  DEFAULT_CALIBRATION,
  type Calibration,
  type RiskBand,
  type ScoreResult,
} from './score';

/** Tamaño de página para las lecturas paginadas (el tope de PostgREST es 1.000). */
const PAGE = 1000;

/** Cuántos movimientos se devuelven para pintar el historial de la ficha. */
export const HISTORY_LIMIT = 50;

// ── Formas de fila del espejo ────────────────────────────────────────────────

export interface WithdrawalRow {
  external_id: string;
  user_external_id: string | null;
  username: string | null;
  email: string | null;
  requested_amount: number | null;
  transaction_amount: number | null;
  fee: number | null;
  coin: string | null;
  network: string | null;
  processor: string | null;
  status_raw: string | null;
  status_norm: string;
  type: string | null;
  requested_at: string | null;
  authorized_at: string | null;
  processed_at: string | null;
  target_address: string | null;
}

const WITHDRAWAL_COLS =
  'external_id, user_external_id, username, email, requested_amount, transaction_amount, fee, ' +
  'coin, network, processor, status_raw, status_norm, type, requested_at, authorized_at, ' +
  'processed_at, target_address';

export interface DepositRow {
  external_id: string;
  user_external_id: string | null;
  amount_paid: number | null;
  coin: string | null;
  network: string | null;
  is_fiat: boolean | null;
  external_payment_id: string | null;
  status_raw: string | null;
  status_norm: string;
  deposit_at: string | null;
}

const DEPOSIT_COLS =
  'external_id, user_external_id, amount_paid, coin, network, is_fiat, external_payment_id, ' +
  'status_raw, status_norm, deposit_at';

export interface UserSnapshotRow {
  user_external_id: string;
  username: string | null;
  email: string | null;
  country: string | null;
  status: string | null;
  kyc_status: string | null;
  user_type: string | null;
  register_date: string | null;
  sponsor_username: string | null;
  rank: string | null;
  pending_fee_debt: number | null;
}

const USER_COLS =
  'user_external_id, username, email, country, status, kyc_status, user_type, register_date, ' +
  'sponsor_username, rank, pending_fee_debt';

export interface ReviewRow {
  withdrawal_external_id: string;
  score: number | null;
  score_band: RiskBand | null;
  factors: unknown;
  decision: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  notes: string | null;
}

const REVIEW_COLS =
  'withdrawal_external_id, score, score_band, factors, decision, decided_by_name, decided_at, notes';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recorre TODAS las páginas de una consulta. Sin esto, PostgREST corta en
 * 1.000 filas sin avisar y un cliente con mucho historial quedaría con el
 * comportamiento truncado — o sea, con un score inventado.
 */
async function fetchAllPages<T>(
  // El builder de PostgREST tipa `data` según el schema generado, que este
  // proyecto no tiene: por eso entra como `unknown[]` y se afirma a `T[]` acá,
  // en UN solo lugar, en vez de sembrar `as any` en cada llamada.
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Método de pago legible. El `walletType` del CRM NO sirve (trampa 3 de la
 * migración 088: es 'BALANCE' en todo): el método real se infiere de
 * coin + network.
 */
export function paymentMethodOf(coin: string | null, network: string | null, isFiat?: boolean | null): string {
  const c = (coin ?? '').trim().toUpperCase();
  const n = (network ?? '').trim().toUpperCase();
  if (isFiat || c === 'USD') return n ? `FIAT ${c || 'USD'} · ${n}` : `FIAT ${c || 'USD'}`;
  if (!c && !n) return 'sin dato';
  return n ? `${c || 'CRIPTO'} · ${n}` : c;
}

/** Agrupa movimientos por usuario en un Map, para no barrer el array por retiro. */
function groupByUser<T extends { user_external_id: string | null }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.user_external_id;
    if (!k) continue;
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ── Cola ─────────────────────────────────────────────────────────────────────

export interface QueueFilters {
  minAmount?: number | null;
  maxAmount?: number | null;
  band?: RiskBand | null;
  processor?: string | null;
  coin?: string | null;
  /** Sólo solicitudes con más de N días de antigüedad (envejecimiento de la cola). */
  olderThanDays?: number | null;
  /** Búsqueda libre por username / email / id de retiro. */
  q?: string | null;
  /**
   * Rango de fechas de SOLICITUD (`YYYY-MM-DD`, inclusive los dos extremos).
   *
   * Se aplica a las TRES secciones a la vez y no sólo a una: si cada tabla
   * mirara un período distinto, la pantalla estaría contando cosas de momentos
   * distintos al mismo tiempo y nadie podría leerla.
   */
  from?: string | null;
  to?: string | null;
}

/** De dónde salió el dinero del cliente, para pintarlo en la ficha. */
export interface WalletSourcesRow {
  user_external_id: string;
  in_p2p: number | null;
  in_ib: number | null;
  in_social: number | null;
  in_propfirm: number | null;
  in_trading: number | null;
  in_deposit: number | null;
  out_p2p: number | null;
}

export interface QueueItem {
  withdrawal: WithdrawalRow;
  /** Aprobado solo por el sistema. Ver INSTANT_FEE. */
  wasInstant: boolean;
  /** Método inferido de coin+network (el walletType del CRM no sirve). */
  paymentMethod: string;
  /** Días que lleva esperando la solicitud. */
  ageDays: number | null;
  features: WithdrawalFeatures;
  score: ScoreResult;
  user: UserSnapshotRow | null;
  /** Revisión ya registrada por el equipo, si la hay. */
  review: ReviewRow | null;
  sources: WalletSourcesRow | null;
}

/**
 * Un retiro que ESTUVO en la cola y ya no: alguien lo movió, en el CRM o acá.
 * Se lista aparte con el estado en el que quedó, porque el estado puede seguir
 * cambiando —REQUESTED → ON_HOLD → REVIEWED → IN_PROCESS— hasta llegar a
 * COMPLETED, FAILED o REJECTED, y lo que importa es dónde terminó.
 */
export interface ResolvedItem {
  externalId: string;
  username: string | null;
  email: string | null;
  amount: number | null;
  requestedAt: string | null;
  processedAt: string | null;
  /** El estado CRUDO del CRM: 'COMPLETED', 'REJECTED', 'FAILED'… */
  statusRaw: string | null;
  statusNorm: string;
  wasInstant: boolean;
  /** Qué decidimos nosotros, si es que llegamos a decidir algo. */
  ourDecision: string | null;
  ourDecidedBy: string | null;
  /**
   * El score TAL COMO SE GUARDÓ al decidir (withdrawal_reviews.score, escala
   * approvalScore 0-100). null = nunca se revisó acá; NO se recalcula
   * retroactivamente — un score calculado hoy con los features de hoy no es
   * el que se vio al decidir, y mostrarlo como si lo fuera mentiría.
   * Para los aún-pendientes tocados (desdeCola) sí es el score vivo actual.
   */
  score: number | null;
  scoreBand: RiskBand | null;
}

export interface QueueResult {
  /**
   * SOLICITADOS: los que esperan una primera decisión y NO cambiaron de estado
   * (`status_raw = 'REQUESTED'`). Kevin, 2026-08-26.
   *
   * Un retiro que alguien movió a ON_HOLD ya cambió de estado y por lo tanto
   * vive en `resolved`, aunque siga esperando decisión: lo que separa las
   * secciones es si alguien lo tocó, no si está cerrado.
   */
  items: QueueItem[];
  /** INSTANTÁNEOS: aprobados solos por el sistema. Nunca se mezclan. */
  instant: QueueItem[];
  /** Los que cambiaron de estado. Ver ResolvedItem. */
  resolved: ResolvedItem[];
  /** Pendientes antes de aplicar los filtros (para mostrar "N de M"). */
  totalPending: number;
  calibrationId: string;
  counts: Record<RiskBand, number>;
  /**
   * Qué listas llegaron al tope y por lo tanto están RECORTADAS.
   *
   * Existe porque un recorte silencioso es indistinguible de "no hay más": la
   * pantalla mostraría 1.000 filas con cara de ser todas. Con esto puede
   * decir "hay más, acotá las fechas".
   */
  truncated: { instant: boolean; resolved: boolean };
}

/**
 * Cola de retiros PENDIENTES de la empresa, con score.
 *
 * Los filtros de importe / procesador / moneda / antigüedad / texto se
 * empujan a Postgres (usan idx_crm_withdrawals_pending). El de BANDA se
 * aplica en memoria por necesidad: la banda no está en la tabla, sale del
 * score, y el score se calcula acá.
 */
export async function loadQueue(
  admin: SupabaseClient,
  companyId: string,
  filters: QueueFilters = {},
  cal: Calibration = DEFAULT_CALIBRATION,
): Promise<QueueResult> {
  // ── QUÉ ENTRA EN LA COLA (Kevin, 2026-08-25) ────────────────────────────
  // Dos cosas y sólo dos:
  //
  //   PEDIDOS    los que esperan decisión: REQUESTED, ON_HOLD, REVIEWED,
  //              IN_PROCESS. Todos caen en status_norm='pending'.
  //   INSTANTES  los que el sistema aprueba SOLO. Ya salió el dinero, así que
  //              no hay nada que decidir — pero hay que poder ver qué tan
  //              arriesgado era, que es justamente lo que nadie miraba.
  //
  // Los instantáneos se reconocen por la COMISIÓN DE $5: el admin del broker
  // los sirve por otro endpoint (/api/withdraws/instant) y no traen ningún
  // campo propio que los marque, pero la comisión estándar es $3 y la de ellos
  // $5.
  //
  // ── ES UN HEURÍSTICO, Y HAY QUE SABERLO ─────────────────────────────────
  // Medido el 2026-08-26: 167 retiros con fee=5, TODOS COMPLETED, todos entre
  // el 23 y el 26 de agosto. El resto de la tabla usa fee=3 (13.101) o fee=0
  // (465), más una decena de importes sueltos de noviembre de 2025.
  //
  // El día que el bróker cambie esa comisión, los instantáneos dejan de
  // detectarse EN SILENCIO: no hay error, simplemente la lista se queda corta.
  // Si algún día aparecen retiros instantáneos con otra comisión, este es el
  // único lugar que hay que tocar.

  /** Filtros que valen para las TRES secciones por igual. */
  const comunes = <T extends ReturnType<typeof baseQuery>>(q: T): T => {
    let r = q;
    if (typeof filters.minAmount === 'number') r = r.gte('requested_amount', filters.minAmount) as T;
    if (typeof filters.maxAmount === 'number') r = r.lte('requested_amount', filters.maxAmount) as T;
    if (filters.processor) r = r.eq('processor', filters.processor) as T;
    if (filters.coin) r = r.eq('coin', filters.coin) as T;
    if (typeof filters.olderThanDays === 'number' && filters.olderThanDays > 0) {
      const cut = new Date(Date.now() - filters.olderThanDays * 86_400_000).toISOString();
      r = r.lte('requested_at', cut) as T;
    }
    // El rango de fechas va al DÍA COMPLETO: `to` inclusive significa hasta el
    // último instante de ese día, no hasta su medianoche — que dejaría fuera
    // todo lo del día elegido.
    if (filters.from) r = r.gte('requested_at', `${filters.from}T00:00:00.000Z`) as T;
    if (filters.to) r = r.lte('requested_at', `${filters.to}T23:59:59.999Z`) as T;
    if (filters.q) {
      // `escapeLike` protege el patrón de PostgREST: una coma o un paréntesis
      // en la búsqueda rompería el `or(...)` y podría ensanchar el filtro.
      const term = escapeLike(filters.q.trim());
      if (term) r = r.or(`username.ilike.%${term}%,email.ilike.%${term}%,external_id.ilike.%${term}%`) as T;
    }
    return r;
  };

  function baseQuery() {
    return admin
      .from('crm_withdrawals')
      .select(WITHDRAWAL_COLS)
      .eq('company_id', companyId)
      .order('requested_at', { ascending: false, nullsFirst: false });
  }

  // ── DOS CONSULTAS Y NO UNA ──────────────────────────────────────────────
  // Antes las dos secciones venían de un solo `.or()` con un `.limit(500)`
  // compartido. Eso tenía un recorte silencioso esperando: en cuanto los
  // instantáneos pasaran de ~495, el límite empezaría a comerse filas sin que
  // nada avisara. Separadas, cada una tiene su tope y su aviso.
  const [pendRes, instRes] = await Promise.all([
    comunes(baseQuery()).eq('status_norm', 'pending').limit(PENDING_MAX),
    comunes(baseQuery()).eq('fee', INSTANT_FEE).limit(INSTANT_MAX),
  ]);
  if (pendRes.error) throw new Error(pendRes.error.message);
  if (instRes.error) throw new Error(instRes.error.message);

  const pending = (pendRes.data ?? []) as unknown as WithdrawalRow[];
  const instantRows = (instRes.data ?? []) as unknown as WithdrawalRow[];

  const { count } = await admin
    .from('crm_withdrawals')
    .select('external_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status_norm', 'pending')
    .eq('status_raw', UNTOUCHED_STATUS);

  const todos = await scoreMany(admin, companyId, [...pending, ...instantRows], cal);

  // ── LA COLA SE PARTE EN DOS ─────────────────────────────────────────────
  // Los instantáneos ya cobraron: no hay nada que decidir sobre ellos, sólo
  // que mirar qué tan arriesgados eran. Mezclarlos con los que esperan
  // decisión convierte una lista de trabajo en una lista de lectura.
  const instant = todos.filter((i) => i.wasInstant);
  const items = todos.filter(
    (i) => !i.wasInstant && i.withdrawal.status_raw === UNTOUCHED_STATUS,
  );

  // Los pendientes que YA fueron tocados (ON_HOLD y compañía) no desaparecen:
  // bajan al historial con su estado actual. Siguen esperando decisión, y por
  // eso el estado se muestra crudo y en color de aviso, no como si estuvieran
  // cerrados.
  const tocados = todos.filter(
    (i) => !i.wasInstant && i.withdrawal.status_raw !== UNTOUCHED_STATUS,
  );

  // ── Los que ya cambiaron de estado ──────────────────────────────────────
  // Se listan los pedidos en la ventana que YA NO están pendientes. Es la
  // única forma de cerrar el ciclo: alguien mira la cola, vuelve al día
  // siguiente y quiere saber en qué terminó lo que vio ayer.
  //
  // Los instantáneos se excluyen de acá: nacen resueltos, así que aparecerían
  // todos y taparían a los que de verdad cambiaron.
  // El historial usa el MISMO rango que el resto de la pantalla. Sólo cuando
  // no hay rango cae a su ventana por defecto: sin ella la primera carga
  // traería los 13.690 retiros de la historia entera.
  let qr = admin
    .from('crm_withdrawals')
    .select(WITHDRAWAL_COLS)
    .eq('company_id', companyId)
    .neq('status_norm', 'pending')
    .neq('fee', INSTANT_FEE)
    .order('processed_at', { ascending: false, nullsFirst: false });

  if (filters.from || filters.to) {
    if (filters.from) qr = qr.gte('requested_at', `${filters.from}T00:00:00.000Z`);
    if (filters.to) qr = qr.lte('requested_at', `${filters.to}T23:59:59.999Z`);
  } else {
    qr = qr.gte('requested_at', new Date(Date.now() - RESOLVED_DAYS * 86_400_000).toISOString());
  }

  const { data: resueltos, error: rErr } = await qr.limit(RESOLVED_MAX);
  if (rErr) throw new Error(rErr.message);

  const resueltosRows = (resueltos ?? []) as unknown as WithdrawalRow[];
  const nuestrasDecisiones = new Map<string, ReviewRow>();
  if (resueltosRows.length > 0) {
    const { data: revs } = await admin
      .from('withdrawal_reviews')
      .select(REVIEW_COLS)
      .eq('company_id', companyId)
      .in('withdrawal_external_id', resueltosRows.map((r) => r.external_id));
    for (const r of (revs ?? []) as unknown as ReviewRow[]) {
      nuestrasDecisiones.set(r.withdrawal_external_id, r);
    }
  }

  // Los pendientes ya tocados se suman al historial. Se construyen igual que
  // los cerrados para que la tabla no tenga que distinguirlos: lo que los
  // distingue es su estado, y ese ya se muestra.
  const desdeCola: ResolvedItem[] = tocados.map((i) => ({
    externalId: i.withdrawal.external_id,
    username: i.withdrawal.username,
    email: i.withdrawal.email,
    amount: i.withdrawal.requested_amount,
    requestedAt: i.withdrawal.requested_at,
    processedAt: i.withdrawal.processed_at,
    statusRaw: i.withdrawal.status_raw,
    statusNorm: i.withdrawal.status_norm,
    wasInstant: false,
    ourDecision: i.review?.decision ?? null,
    ourDecidedBy: i.review?.decided_by_name ?? null,
    score: i.score.approvalScore,
    scoreBand: i.score.band,
  }));

  const resolved: ResolvedItem[] = resueltosRows.map((w) => {
    const nuestra = nuestrasDecisiones.get(w.external_id) ?? null;
    return {
      externalId: w.external_id,
      username: w.username,
      email: w.email,
      amount: w.requested_amount,
      requestedAt: w.requested_at,
      processedAt: w.processed_at,
      statusRaw: w.status_raw,
      statusNorm: w.status_norm,
      wasInstant: isInstant(w),
      ourDecision: nuestra?.decision ?? null,
      ourDecidedBy: nuestra?.decided_by_name ?? null,
      score: nuestra?.score ?? null,
      scoreBand: nuestra?.score_band ?? null,
    };
  });

  const filtered = filters.band ? items.filter((i) => i.score.band === filters.band) : items;
  const instantFiltrados = filters.band
    ? instant.filter((i) => i.score.band === filters.band)
    : instant;

  // Los contadores de banda cuentan las DOS colas: son el semáforo de "cuánto
  // riesgo hay", y dejar los instantáneos afuera escondería justo los que ya
  // salieron sin que nadie los mirara.
  const counts: Record<RiskBand, number> = { low: 0, medium: 0, high: 0 };
  for (const i of [...items, ...instant]) counts[i.score.band] += 1;

  // ── SOLICITADOS: por fecha, lo más RECIENTE arriba ──────────────────────
  // Antes mandaba el riesgo (el score más bajo arriba). Cambiado a pedido de
  // Stiven (2026-08-27): la cola se lee como una bandeja de entrada, lo último
  // que entró primero.
  //
  // OJO AL LEERLA: un retiro de riesgo ALTO puede quedar abajo si es viejo.
  // La señal de riesgo ahora vive en la columna Score y en el filtro de bandas,
  // NO en la posición de la fila. Los contadores de banda de arriba siguen
  // siendo el semáforo de "cuánto riesgo hay esperando".
  filtered.sort((a, b) =>
    (b.withdrawal.requested_at ?? '').localeCompare(a.withdrawal.requested_at ?? ''),
  );

  // ── INSTANTÁNEOS: sin cambios, lo más riesgoso arriba ───────────────────
  // Estos YA salieron sin que nadie los mirara, así que acá el orden por
  // riesgo sí es lo útil: lo que hay que auditar primero es lo más riesgoso,
  // no lo más nuevo. A igual score, lo que más tiempo lleva esperando.
  const porRiesgo = (a: QueueItem, b: QueueItem) =>
    a.score.approvalScore - b.score.approvalScore || (b.ageDays ?? 0) - (a.ageDays ?? 0);
  instantFiltrados.sort(porRiesgo);

  return {
    items: filtered,
    instant: instantFiltrados,
    // El historial junta lo cerrado con lo que sigue abierto pero ya se tocó.
    // Lo más reciente arriba, sin importar de cuál de los dos venga.
    resolved: [...desdeCola, ...resolved].sort((a, b) =>
      (b.processedAt ?? b.requestedAt ?? '').localeCompare(a.processedAt ?? a.requestedAt ?? ''),
    ),
    totalPending: count ?? items.length,
    calibrationId: cal.id,
    counts,
    truncated: {
      instant: instantRows.length >= INSTANT_MAX,
      resolved: resueltosRows.length >= RESOLVED_MAX,
    },
  };
}

/**
 * El único estado que cuenta como "solicitado y sin tocar". Cualquier otro
 * —ON_HOLD, REVIEWED, IN_PROCESS— significa que alguien ya lo movió, así que
 * pasa al historial con el estado en el que quedó.
 */
export const UNTOUCHED_STATUS = 'REQUESTED';

/**
 * Comisión que identifica un retiro instantáneo. Ver la cabecera de loadQueue:
 * es el único rasgo que los distingue en los datos.
 */
export const INSTANT_FEE = 5;

/**
 * ── LA VENTANA DE 7 DÍAS SE QUITÓ (Kevin, 2026-08-26) ──────────────────────
 * Decía: "ya están cobrados, así que mostrarlos para siempre convertiría la
 * cola en un archivo histórico". El razonamiento era bueno pero la conclusión
 * era prematura: Kevin quiere verlos TODOS, y el filtro por fechas —que ahora
 * existe— es la respuesta correcta al problema que esa ventana intentaba
 * evitar. La lista se acota cuando hace falta, no siempre.
 *
 * La ventana además era una bomba de tiempo sin estallar: hoy los 167
 * instantáneos caben en 7 días porque la función se lanzó el 23 de agosto. El
 * 30 de agosto los primeros habrían empezado a desaparecer solos.
 *
 * Topes: cada lista tiene el suyo y avisa cuando lo toca. Un recorte
 * silencioso es indistinguible de "no hay más".
 */
const INSTANT_MAX = 1000;
const PENDING_MAX = 500;
const RESOLVED_MAX = 500;

/** Ventana de "ya cambiaron de estado". Misma lógica: cerrar el ciclo, no archivar. */
const RESOLVED_DAYS = 7;
/** ¿Este retiro fue instantáneo (aprobado solo por el sistema)? */
export function isInstant(w: { fee: number | null }): boolean {
  return Number(w.fee) === INSTANT_FEE;
}

/** Neutraliza los metacaracteres que rompen un patrón `ilike` dentro de `or(...)`. */
function escapeLike(s: string): string {
  return s.replace(/[%_,()\\]/g, '');
}

/**
 * Puntúa un lote de retiros con 3 consultas fijas (usuarios, depósitos,
 * retiros históricos) más una por las revisiones ya registradas. Es el
 * antídoto al N+1 descripto en la cabecera.
 */
async function scoreMany(
  admin: SupabaseClient,
  companyId: string,
  withdrawals: WithdrawalRow[],
  cal: Calibration,
): Promise<QueueItem[]> {
  if (withdrawals.length === 0) return [];

  const userIds = [...new Set(withdrawals.map((w) => w.user_external_id).filter((x): x is string => !!x))];
  const addresses = [...new Set(withdrawals.map((w) => w.target_address).filter((x): x is string => !!x))];

  const [users, deposits, history, reviews, sources, addressOwners] = await Promise.all([
    userIds.length
      ? fetchAllPages<UserSnapshotRow>((from, to) =>
          admin
            .from('crm_user_snapshots')
            .select(USER_COLS)
            .eq('company_id', companyId)
            .in('user_external_id', userIds)
            .range(from, to),
        )
      : Promise.resolve([]),
    userIds.length
      ? fetchAllPages<{ user_external_id: string | null; amount_paid: number | null; deposit_at: string | null }>(
          (from, to) =>
            admin
              .from('crm_deposits')
              .select('user_external_id, amount_paid, deposit_at')
              .eq('company_id', companyId)
              .in('user_external_id', userIds)
              .eq('status_norm', 'completed')
              .range(from, to),
        )
      : Promise.resolve([]),
    userIds.length
      ? fetchAllPages<{ user_external_id: string | null; requested_amount: number | null; requested_at: string | null; status_norm: string }>(
          (from, to) =>
            admin
              .from('crm_withdrawals')
              .select('user_external_id, requested_amount, requested_at, status_norm')
              .eq('company_id', companyId)
              .in('user_external_id', userIds)
              .in('status_norm', ['approved', 'rejected'])
              .range(from, to),
        )
      : Promise.resolve([]),
    fetchAllPages<ReviewRow>((from, to) =>
      admin
        .from('withdrawal_reviews')
        .select(REVIEW_COLS)
        .eq('company_id', companyId)
        .in('withdrawal_external_id', withdrawals.map((w) => w.external_id))
        .range(from, to),
    ),
    // Origen del dinero. SÍ puntúa: es la señal más fuerte del módulo.
    userIds.length
      ? fetchAllPages<{ user_external_id: string; in_p2p: number | null; in_ib: number | null; in_social: number | null; in_propfirm: number | null; in_trading: number | null; in_deposit: number | null; out_p2p: number | null }>(
          (from, to) =>
            admin
              .from('crm_wallet_sources')
              .select('user_external_id, in_p2p, in_ib, in_social, in_propfirm, in_trading, in_deposit, out_p2p')
              .eq('company_id', companyId)
              .in('user_external_id', userIds)
              .range(from, to),
        )
      : Promise.resolve([]),
    // Sólo para el CONTEXTO informativo: cuántos usuarios distintos comparten
    // la dirección. No puntúa (ver score.ts), pero el analista quiere verlo.
    addresses.length
      ? fetchAllPages<{ target_address: string | null; user_external_id: string | null }>((from, to) =>
          admin
            .from('crm_withdrawals')
            .select('target_address, user_external_id')
            .eq('company_id', companyId)
            .in('target_address', addresses)
            .range(from, to),
        )
      : Promise.resolve([]),
  ]);

  const userById = new Map(users.map((u) => [u.user_external_id, u]));
  const depsByUser = groupByUser(deposits);
  const histByUser = groupByUser(history);
  const reviewById = new Map(reviews.map((r) => [r.withdrawal_external_id, r]));
  const sourcesByUser = new Map(sources.map((s) => [s.user_external_id, s]));
  const usersByAddress = new Map<string, Set<string>>();
  for (const a of addressOwners) {
    if (!a.target_address || !a.user_external_id) continue;
    const set = usersByAddress.get(a.target_address) ?? new Set<string>();
    set.add(a.user_external_id);
    usersByAddress.set(a.target_address, set);
  }

  const now = Date.now();

  return withdrawals.map((w) => {
    const uid = w.user_external_id ?? '';
    const user = userById.get(uid) ?? null;
    const hist = histByUser.get(uid) ?? [];
    const cut = w.requested_at ? new Date(w.requested_at).getTime() : null;

    const features = computeFeatures({
      amount: w.requested_amount,
      requestedAt: w.requested_at,
      depositsBefore: (depsByUser.get(uid) ?? []).map((d) => ({ amount: d.amount_paid, at: d.deposit_at })),
      withdrawalsApprovedBefore: hist
        .filter((h) => h.status_norm === 'approved')
        .map((h) => ({ amount: h.requested_amount, at: h.requested_at })),
      rejectedCountBefore: hist.filter(
        (h) =>
          h.status_norm === 'rejected' &&
          h.requested_at !== null &&
          cut !== null &&
          new Date(h.requested_at).getTime() < cut,
      ).length,
      registerDate: user?.register_date ?? null,
      kycStatus: user?.kyc_status ?? null,
      pendingFeeDebt: user?.pending_fee_debt ?? null,
      sharedAddressUserCount: w.target_address ? (usersByAddress.get(w.target_address)?.size ?? 1) : 0,
      // Origen del dinero: el P2P recibido decide el tramo, y el correo decide
      // si es personal del broker (a quien no se le mide igual).
      p2pReceived: sourcesByUser.get(uid)?.in_p2p ?? 0,
      email: w.email ?? user?.email ?? null,
    });

    return {
      withdrawal: w,
      wasInstant: isInstant(w),
      paymentMethod: paymentMethodOf(w.coin, w.network),
      ageDays: cut === null ? null : Math.max(0, (now - cut) / 86_400_000),
      features,
      score: scoreWithdrawal(features, cal),
      user,
      sources: sourcesByUser.get(uid) ?? null,
      review: reviewById.get(w.external_id) ?? null,
    };
  });
}

// ── Ficha ────────────────────────────────────────────────────────────────────

export interface WithdrawalDetail extends QueueItem {
  /** Últimos depósitos del cliente (todos los estados), con el método inferido. */
  depositHistory: Array<DepositRow & { paymentMethod: string; beforeRequest: boolean }>;
  /** Retiros previos del cliente (todos los estados), con el método inferido. */
  withdrawalHistory: Array<WithdrawalRow & { paymentMethod: string; beforeRequest: boolean }>;
  /** KYC / deuda / dirección compartida. SIEMPRE con affectsScore:false. */
  informative: ReturnType<typeof informativeNotes>;
  /**
   * Historial completo de decisiones, del más nuevo al más viejo (migración
   * 089). `review` dice en qué estado está; esto dice cómo se llegó ahí — que
   * es lo que se pierde si sólo se guarda la última decisión.
   */
  events: ReviewEventRow[];
  /**
   * Actividad de trading del cliente (migración 090). CONTEXTO, no score:
   * medido contra los 3.711 retiros decididos de los últimos 45 días, "nunca
   * operó" tuvo CERO rechazos en 20 casos — la intuición de que depositar y
   * retirar sin operar es sospechoso NO se sostiene en la data. Lo que sí
   * aparece es que empezar a operar DESPUÉS de pedir el retiro se rechaza al
   * 19,51% contra un 2,69% de base, pero con sólo 41 casos.
   */
  trading: TradingActivity | null;
}

/** Resumen de trading del cliente, sumando sus cuentas reales (nunca demo). */
export interface TradingActivity {
  accounts: number;
  demoAccounts: number;
  dealsCount: number;
  profit: number | null;
  firstDealAt: string | null;
  lastDealAt: string | null;
  /** ¿Ya había operado ANTES de pedir este retiro? El corte punto-en-el-tiempo. */
  tradedBeforeRequest: boolean | null;
  /** Sin ninguna cuenta MT5 con ese correo: puede ser real o un correo distinto. */
  noMt5Account: boolean;
}

interface Mt5ActivityRow {
  login: number;
  deals_count: number | null;
  profit: number | null;
  first_deal_at: string | null;
  last_deal_at: string | null;
  is_demo: boolean;
}

/** Una decisión, tal como quedó registrada. La tabla es append-only. */
export interface ReviewEventRow {
  decision: string;
  notes: string | null;
  score: number | null;
  score_band: RiskBand | null;
  calibration_id: string | null;
  actor_name: string | null;
  /** Rol del autor EN EL MOMENTO del hecho, no el de hoy. */
  actor_role: string | null;
  created_at: string;
}

const EVENT_COLS =
  'decision, notes, score, score_band, calibration_id, actor_name, actor_role, created_at';

/**
 * Ficha completa de un retiro. Devuelve `null` si el id no existe EN ESTA
 * empresa — el filtro por `company_id` va siempre, nunca se confía en que el
 * external_id sea único entre tenants.
 */
export async function loadWithdrawalDetail(
  admin: SupabaseClient,
  companyId: string,
  externalId: string,
  cal: Calibration = DEFAULT_CALIBRATION,
): Promise<WithdrawalDetail | null> {
  const { data: row, error } = await admin
    .from('crm_withdrawals')
    .select(WITHDRAWAL_COLS)
    .eq('company_id', companyId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;

  const withdrawal = row as unknown as WithdrawalRow;
  const [base] = await scoreMany(admin, companyId, [withdrawal], cal);
  const uid = withdrawal.user_external_id;
  const cut = withdrawal.requested_at ? new Date(withdrawal.requested_at).getTime() : null;

  // El historial que se PINTA es distinto del que PUNTÚA: acá se muestran
  // todos los estados (para que el analista vea los cancelados y los
  // rechazados), marcando cuáles son anteriores a la solicitud — que son los
  // únicos que entraron al score.
  const [deps, wds, mt5, events] = await Promise.all([
    uid
      ? admin
          .from('crm_deposits')
          .select(DEPOSIT_COLS)
          .eq('company_id', companyId)
          .eq('user_external_id', uid)
          .order('deposit_at', { ascending: false, nullsFirst: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    uid
      ? admin
          .from('crm_withdrawals')
          .select(WITHDRAWAL_COLS)
          .eq('company_id', companyId)
          .eq('user_external_id', uid)
          .neq('external_id', externalId)
          .order('requested_at', { ascending: false, nullsFirst: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    withdrawal.email
      ? admin
          .from('mt5_account_activity')
          .select('login, deals_count, profit, first_deal_at, last_deal_at, is_demo')
          .eq('company_id', companyId)
          .eq('email', withdrawal.email.trim().toLowerCase())
      : Promise.resolve({ data: [], error: null }),
    admin
      .from('withdrawal_review_events')
      .select(EVENT_COLS)
      .eq('company_id', companyId)
      .eq('withdrawal_external_id', externalId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  if (deps.error) throw new Error(deps.error.message);
  if (wds.error) throw new Error(wds.error.message);
  if (events.error) throw new Error(events.error.message);
  if (mt5.error) throw new Error(mt5.error.message);

  const isBefore = (at: string | null) =>
    cut !== null && at !== null && new Date(at).getTime() < cut;

  return {
    ...base,
    depositHistory: ((deps.data ?? []) as unknown as DepositRow[]).map((d) => ({
      ...d,
      paymentMethod: paymentMethodOf(d.coin, d.network, d.is_fiat),
      beforeRequest: isBefore(d.deposit_at),
    })),
    withdrawalHistory: ((wds.data ?? []) as unknown as WithdrawalRow[]).map((w) => ({
      ...w,
      paymentMethod: paymentMethodOf(w.coin, w.network),
      beforeRequest: isBefore(w.requested_at),
    })),
    informative: informativeNotes(base.features),
    events: (events.data ?? []) as unknown as ReviewEventRow[],
    trading: summarizeTrading((mt5.data ?? []) as unknown as Mt5ActivityRow[], cut),
  };
}

/**
 * Suma las cuentas REALES del cliente. Las demo se cuentan aparte y nunca se
 * suman: operar en demo no es operar el dinero depositado.
 *
 * `tradedBeforeRequest` queda en null cuando no hay ninguna cuenta: "no lo
 * sabemos" y "no operó" son cosas distintas, y mezclarlas haría que un correo
 * que no casó pareciera un cliente que no operó.
 */
function summarizeTrading(rows: Mt5ActivityRow[], cut: number | null): TradingActivity | null {
  if (rows.length === 0) {
    return {
      accounts: 0, demoAccounts: 0, dealsCount: 0, profit: null,
      firstDealAt: null, lastDealAt: null, tradedBeforeRequest: null, noMt5Account: true,
    };
  }
  const real = rows.filter((r) => !r.is_demo);
  const times = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).map((x) => new Date(x).getTime());
  const firsts = times(real.map((r) => r.first_deal_at));
  const lasts = times(real.map((r) => r.last_deal_at));
  const dealsCount = real.reduce((s, r) => s + (r.deals_count ?? 0), 0);
  const firstMs = firsts.length ? Math.min(...firsts) : null;

  return {
    accounts: real.length,
    demoAccounts: rows.length - real.length,
    dealsCount,
    profit: real.some((r) => r.profit !== null) ? real.reduce((s, r) => s + (r.profit ?? 0), 0) : null,
    firstDealAt: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastDealAt: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,
    tradedBeforeRequest: dealsCount === 0 ? false : firstMs === null || cut === null ? null : firstMs < cut,
    noMt5Account: false,
  };
}
