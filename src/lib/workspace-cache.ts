// ─── Workspace cache (fase 4b — SWR casero) ────────────────────────────────
//
// Pinta desde caché, revalida en red; sin dependencia nueva (nada de React
// Query / SWR). Con la DB en eu-west-2 y usuarios en LatAm/Dubai, cada F5 o
// cambio de empresa re-corría la cascada completa de fetches contra Londres
// antes de pintar nada. Este módulo guarda un snapshot del workspace en
// localStorage (volumen chico, ~1-2MB máx como JSON) para que data-context
// pueda hidratar el dashboard INSTANTÁNEAMENTE mientras el refresh normal
// de red corre en background y sobreescribe con datos frescos al llegar.
//
// Claves: `fd_ws_cache_v${CACHE_VERSION}_${companyId}` — una por empresa,
// así el snapshot de la empresa A jamás se filtra en la empresa B.

import type {
  Company,
  Period,
  Deposit,
  Withdrawal,
  Expense,
  ExpenseTemplate,
  ExpenseTemplateHidden,
  PreoperativeExpense,
  OperatingIncome,
  BrokerBalance,
  FinancialStatus,
  Partner,
  PartnerDistribution,
  PropFirmSale,
  P2PTransfer,
  LiquidityMovement,
  Investment,
  Employee,
  CommercialProfile,
  CommercialMonthlyResult,
} from './types';

// Bump este número cada vez que cambie la FORMA del snapshot (agregar/quitar
// slices, renombrar campos, cambios de tipos en ./types que afecten datos
// cacheados). Un bump invalida todos los snapshots viejos: loadWorkspaceSnapshot
// simplemente no encuentra la clave nueva y el flujo cae a red como siempre.
export const CACHE_VERSION = 1;

// Un snapshot más viejo que esto se descarta — mejor splash normal que
// pintar números financieros de hace días.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const KEY_PREFIX = 'fd_ws_cache'; // cualquier versión arranca con esto

function cacheKey(companyId: string): string {
  return `${KEY_PREFIX}_v${CACHE_VERSION}_${companyId}`;
}

/**
 * Todos los slices del DataContext que vienen de la DB. Cada campo es
 * opcional: un snapshot viejo (guardado con menos slices, o parcial porque
 * Stage 2 aún no había resuelto) NUNCA debe romper la hidratación — el
 * consumidor defaultéa cada slice individualmente.
 */
export interface WorkspaceSnapshot {
  company?: Company | null;
  periods?: Period[];
  deposits?: Deposit[];
  withdrawals?: Withdrawal[];
  expenses?: Expense[];
  expenseTemplates?: ExpenseTemplate[];
  expenseTemplateHidden?: ExpenseTemplateHidden[];
  preoperativeExpenses?: PreoperativeExpense[];
  operatingIncome?: OperatingIncome[];
  brokerBalance?: BrokerBalance[];
  financialStatus?: FinancialStatus[];
  partners?: Partner[];
  partnerDistributions?: PartnerDistribution[];
  propFirmSales?: PropFirmSale[];
  p2pTransfers?: P2PTransfer[];
  liquidityMovements?: LiquidityMovement[];
  investments?: Investment[];
  employees?: Employee[];
  commercialProfiles?: CommercialProfile[];
  monthlyResults?: CommercialMonthlyResult[];
}

interface StoredEnvelope {
  savedAt: number;
  data: WorkspaceSnapshot;
}

function hasLocalStorage(): boolean {
  // Guard SSR + navegadores con storage deshabilitado (Safari private mode
  // viejo lanzaba al mero acceso).
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * Persiste el snapshot del workspace para una empresa. Nunca lanza: en
 * quota exceeded / private mode limpia todo el caché fd_ws_cache_* y
 * sigue de largo — el caché es una optimización, no una fuente de verdad.
 */
export function saveWorkspaceSnapshot(companyId: string, snapshot: WorkspaceSnapshot): void {
  if (!hasLocalStorage() || !companyId) return;
  const envelope: StoredEnvelope = { savedAt: Date.now(), data: snapshot };
  try {
    window.localStorage.setItem(cacheKey(companyId), JSON.stringify(envelope));
  } catch (err) {
    // QuotaExceededError (u otro fallo de escritura): liberar espacio
    // borrando TODOS los snapshots (cualquier versión) y no reintentar.
    // El próximo load exitoso volverá a escribir.
    console.warn('[workspace-cache] No se pudo guardar el snapshot, limpiando caché:', err);
    clearWorkspaceCache();
  }
}

/**
 * Devuelve el snapshot cacheado para la empresa, o null si no existe,
 * es de otra versión (clave distinta), tiene más de 24h, o está corrupto.
 */
export function loadWorkspaceSnapshot(companyId: string): WorkspaceSnapshot | null {
  if (!hasLocalStorage() || !companyId) return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(companyId));
    if (!raw) return null;
    const envelope = JSON.parse(raw) as StoredEnvelope | null;
    if (!envelope || typeof envelope !== 'object') return null;
    if (typeof envelope.savedAt !== 'number' || !envelope.data || typeof envelope.data !== 'object') {
      return null;
    }
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) {
      // Vencido — borrarlo para no re-parsearlo en cada load.
      try { window.localStorage.removeItem(cacheKey(companyId)); } catch { /* no-op */ }
      return null;
    }
    return envelope.data;
  } catch {
    // JSON corrupto o acceso bloqueado — caer a red silenciosamente.
    return null;
  }
}

/**
 * Borra TODOS los snapshots del workspace (cualquier versión, cualquier
 * empresa). Se llama en logout: datos financieros no deben sobrevivir el
 * cierre de sesión en máquinas compartidas.
 */
export function clearWorkspaceCache(): void {
  if (!hasLocalStorage()) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) toRemove.push(key);
    }
    // Dos pasadas: mutar mientras se itera por índice saltea claves.
    for (const key of toRemove) window.localStorage.removeItem(key);
  } catch {
    // No-op — peor caso el snapshot queda hasta que expire (24h).
  }
}
