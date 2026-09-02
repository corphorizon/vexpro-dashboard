// ─────────────────────────────────────────────────────────────────────────────
// Las LECTURAS del espejo del hedge fund. Server-only.
//
// ── POR QUÉ ESTÁ ACÁ Y NO EN CADA ENDPOINT ─────────────────────────────────
// Los cinco endpoints de `/api/admin/hedge-fund/*` necesitan las mismas cuatro
// o cinco tablas y la MISMA exclusión de datos de prueba. Repetir el paginado y
// el filtro en cada uno es exactamente cómo nacieron las tres copias de
// `leerPerfilesComerciales` que motivaron `hr/crm-net-server.ts` (§1.1).
//
// ── DOS REGLAS QUE NO SE NEGOCIAN ──────────────────────────────────────────
//  1. `.eq('company_id', …)` EXPLÍCITO en cada consulta. El admin client es
//     service role y NO pasa por RLS (§4.2).
//  2. Todo se pagina con `fetchAllRows` y con un `.order()` por columna ÚNICA.
//     PostgREST corta en 1.000 filas SIN AVISAR, y sin orden estable las
//     páginas pueden repetir una fila y saltarse otra. Hoy hay 22 inversiones;
//     el día que sean 1.200 el bug sería «faltan clientes» y nadie lo ataría a
//     esta línea.
//
// ── LA EXCLUSIÓN SE CUENTA ─────────────────────────────────────────────────
// El fondo `qa-tst` y el usuario "Dev Sup" se espejan (G7) y se filtran ACÁ,
// con la lista canónica de `test-data.ts`. Cada lectura devuelve además cuánto
// dejó afuera, y la pantalla lo dibuja: una exclusión silenciosa es
// indistinguible de un cruce roto (§1.2).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows';
import { splitTestData } from './test-data';
import type {
  HfCertificateRow,
  HfCommissionRow,
  HfFundRow,
  HfInvestmentRow,
  HfLedgerRow,
  HfMonthlyReturnRow,
  HfPayoutRow,
  HfWithdrawalRequestRow,
} from './types';

/** Cuánto puede envejecer el espejo antes de que la pantalla avise. */
export const HF_MIRROR_STALE_MS = 24 * 60 * 60 * 1000;

export interface ExclusionCount {
  total: number;
  testFund: number;
  testUser: number;
}

const CERO: ExclusionCount = { total: 0, testFund: 0, testUser: 0 };

function sumar(...partes: ExclusionCount[]): ExclusionCount {
  return partes.reduce(
    (a, b) => ({
      total: a.total + b.total,
      testFund: a.testFund + b.testFund,
      testUser: a.testUser + b.testUser,
    }),
    CERO,
  );
}

function filtrar<T extends { fund_key?: string | null; user_external_id?: string | null }>(
  rows: T[],
): { rows: T[]; excluded: ExclusionCount } {
  const { kept, byReason, excludedCount } = splitTestData(rows);
  return {
    rows: kept,
    excluded: { total: excludedCount, testFund: byReason.test_fund, testUser: byReason.test_user },
  };
}

/** El espejo completo de una empresa, ya sin datos de prueba y con el conteo. */
export interface HedgeFundMirror {
  funds: HfFundRow[];
  investments: HfInvestmentRow[];
  ledger: HfLedgerRow[];
  payouts: HfPayoutRow[];
  commissions: HfCommissionRow[];
  withdrawalRequests: HfWithdrawalRequestRow[];
  monthlyReturns: HfMonthlyReturnRow[];
  certificates: HfCertificateRow[];
  excluded: ExclusionCount;
  /**
   * El `synced_at` más reciente de todo el espejo, o `null` si la empresa nunca
   * se sincronizó. `null` y no la época: «nunca» no es «hace 56 años».
   */
  lastSyncedAt: string | null;
}

/** Qué tablas hace falta leer. Pedir sólo lo necesario, no las nueve siempre. */
export interface MirrorParts {
  funds?: boolean;
  investments?: boolean;
  ledger?: boolean;
  payouts?: boolean;
  commissions?: boolean;
  withdrawalRequests?: boolean;
  monthlyReturns?: boolean;
  certificates?: boolean;
}

export async function readHedgeFundMirror(
  admin: SupabaseClient,
  companyId: string,
  parts: MirrorParts,
): Promise<HedgeFundMirror> {
  const vacio: HedgeFundMirror = {
    funds: [], investments: [], ledger: [], payouts: [], commissions: [],
    withdrawalRequests: [], monthlyReturns: [], certificates: [],
    excluded: { ...CERO }, lastSyncedAt: null,
  };

  const pedir = async <T>(tabla: string, orden: string): Promise<T[]> =>
    fetchAllRows<T>((from, to) =>
      admin
        .from(tabla)
        .select('*')
        .eq('company_id', companyId)
        .order(orden, { ascending: true })
        .range(from, to),
    );

  // En paralelo: son consultas independientes contra NUESTRA base, no contra
  // el CRM. Lo que se serializa en este repo son las idas al broker.
  const [
    funds, investments, ledger, payouts, commissions, withdrawals, monthly, certs,
  ] = await Promise.all([
    parts.funds ? pedir<HfFundRow>('crm_hf_funds', 'fund_key') : Promise.resolve([]),
    parts.investments ? pedir<HfInvestmentRow>('crm_hf_investments', 'investment_id') : Promise.resolve([]),
    parts.ledger ? pedir<HfLedgerRow>('crm_hf_ledger_entries', 'entry_id') : Promise.resolve([]),
    parts.payouts ? pedir<HfPayoutRow>('crm_hf_payouts', 'payout_id') : Promise.resolve([]),
    parts.commissions ? pedir<HfCommissionRow>('crm_hf_commissions', 'commission_id') : Promise.resolve([]),
    parts.withdrawalRequests ? pedir<HfWithdrawalRequestRow>('crm_hf_withdrawal_requests', 'request_id') : Promise.resolve([]),
    parts.monthlyReturns ? pedir<HfMonthlyReturnRow>('crm_hf_monthly_returns', 'fund_key') : Promise.resolve([]),
    parts.certificates ? pedir<HfCertificateRow>('crm_hf_certificates', 'certificate_id') : Promise.resolve([]),
  ]);

  const f = filtrar(funds);
  const i = filtrar(investments);
  const l = filtrar(ledger);
  const p = filtrar(payouts);
  const c = filtrar(commissions);
  const w = filtrar(withdrawals);
  const m = filtrar(monthly);
  const ce = filtrar(certs);

  // El reloj del espejo sale de TODAS las filas leídas, incluidas las de
  // prueba: la pregunta es «cuándo corrió el sync», no «cuándo se actualizó lo
  // que muestro».
  const todos = [
    ...funds, ...investments, ...ledger, ...payouts,
    ...commissions, ...withdrawals, ...monthly, ...certs,
  ].map((r) => (r as { synced_at?: string | null }).synced_at).filter((v): v is string => !!v);

  return {
    ...vacio,
    funds: f.rows,
    investments: i.rows,
    ledger: l.rows,
    payouts: p.rows,
    commissions: c.rows,
    withdrawalRequests: w.rows,
    monthlyReturns: m.rows,
    certificates: ce.rows,
    // Las exclusiones se suman de TODAS las tablas leídas: si sólo se contaran
    // las inversiones, un fondo de prueba con cero inversiones desaparecería
    // del aviso y la pantalla diría «0 excluidos» mostrando uno menos.
    excluded: sumar(f.excluded, i.excluded, l.excluded, p.excluded, c.excluded, w.excluded, m.excluded, ce.excluded),
    lastSyncedAt: todos.length > 0 ? todos.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/** `true` cuando el espejo pasó las 24 h. `null` cuando nunca se sincronizó. */
export function mirrorIsStale(lastSyncedAt: string | null, now: Date = new Date()): boolean | null {
  if (!lastSyncedAt) return null;
  const t = Date.parse(lastSyncedAt);
  if (!Number.isFinite(t)) return null;
  return now.getTime() - t > HF_MIRROR_STALE_MS;
}
