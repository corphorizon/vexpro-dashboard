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
}

export interface QueueItem {
  withdrawal: WithdrawalRow;
  /** Método inferido de coin+network (el walletType del CRM no sirve). */
  paymentMethod: string;
  /** Días que lleva esperando la solicitud. */
  ageDays: number | null;
  features: WithdrawalFeatures;
  score: ScoreResult;
  user: UserSnapshotRow | null;
  /** Revisión ya registrada por el equipo, si la hay. */
  review: ReviewRow | null;
}

export interface QueueResult {
  items: QueueItem[];
  /** Pendientes antes de aplicar los filtros (para mostrar "N de M"). */
  totalPending: number;
  calibrationId: string;
  counts: Record<RiskBand, number>;
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
  let q = admin
    .from('crm_withdrawals')
    .select(WITHDRAWAL_COLS)
    .eq('company_id', companyId)
    .eq('status_norm', 'pending')
    .order('requested_at', { ascending: true, nullsFirst: false });

  if (typeof filters.minAmount === 'number') q = q.gte('requested_amount', filters.minAmount);
  if (typeof filters.maxAmount === 'number') q = q.lte('requested_amount', filters.maxAmount);
  if (filters.processor) q = q.eq('processor', filters.processor);
  if (filters.coin) q = q.eq('coin', filters.coin);
  if (typeof filters.olderThanDays === 'number' && filters.olderThanDays > 0) {
    const cut = new Date(Date.now() - filters.olderThanDays * 86_400_000).toISOString();
    q = q.lte('requested_at', cut);
  }
  if (filters.q) {
    // `escapeLike` protege el patrón de PostgREST: una coma o un paréntesis
    // en la búsqueda rompería el `or(...)` y podría ensanchar el filtro.
    const term = escapeLike(filters.q.trim());
    if (term) q = q.or(`username.ilike.%${term}%,email.ilike.%${term}%,external_id.ilike.%${term}%`);
  }

  const { data, error } = await q.limit(500);
  if (error) throw new Error(error.message);
  const pending = (data ?? []) as unknown as WithdrawalRow[];

  const { count } = await admin
    .from('crm_withdrawals')
    .select('external_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status_norm', 'pending');

  const items = await scoreMany(admin, companyId, pending, cal);

  const filtered = filters.band ? items.filter((i) => i.score.band === filters.band) : items;
  const counts: Record<RiskBand, number> = { low: 0, medium: 0, high: 0 };
  for (const i of items) counts[i.score.band] += 1;

  // Lo más riesgoso arriba; a igual banda, lo que más tiempo lleva esperando.
  filtered.sort(
    (a, b) => a.score.approvalScore - b.score.approvalScore || (b.ageDays ?? 0) - (a.ageDays ?? 0),
  );

  return { items: filtered, totalPending: count ?? pending.length, calibrationId: cal.id, counts };
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

  const [users, deposits, history, reviews, addressOwners] = await Promise.all([
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
    });

    return {
      withdrawal: w,
      paymentMethod: paymentMethodOf(w.coin, w.network),
      ageDays: cut === null ? null : Math.max(0, (now - cut) / 86_400_000),
      features,
      score: scoreWithdrawal(features, cal),
      user,
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
