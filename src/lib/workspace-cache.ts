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
// Claves: `fd_ws_cache_v${CACHE_VERSION}_${userId}_${companyId}` — una por
// USUARIO y empresa.
//
// ── Por qué el userId está en la clave (2026-08-28) ────────────────────────
// Hasta hoy la clave era sólo `_${companyId}` y el snapshot se borraba en TODO
// SIGNED_OUT, así que la separación entre usuarios la daba el borrado, no la
// clave. Eso obligaba a tirar el caché también en el auto-logout por
// inactividad de 2h: quien deja la pestaña abierta durante la jornada volvía
// SIEMPRE a un arranque frío (40 round-trips desde LatAm/Dubái).
//
// Para poder conservar el snapshot en el auto-logout hay que cerrar antes la
// trampa conocida del repo — «caché de cliente con clave global = el
// siguiente usuario en la misma máquina ve los datos del anterior». Dos
// candados, no uno:
//   1. La CLAVE lleva userId + companyId.
//   2. El SOBRE guarda userId + companyId y `loadWorkspaceSnapshot` los
//      compara contra la sesión actual antes de devolver nada. Una clave
//      escrita a mano en localStorage no alcanza para hidratar datos ajenos.
// Fijado por workspace-cache.test.ts (usuario B no hidrata el snapshot de A).

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
// v2: la clave pasó a incluir el userId y el sobre guarda su dueño. Los
// snapshots v1 (clave sin usuario) quedan inalcanzables — el arranque
// siguiente cae a red como siempre y reescribe con la clave nueva.
export const CACHE_VERSION = 2;

// Un snapshot más viejo que esto se descarta — mejor splash normal que
// pintar números financieros de hace días.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const KEY_PREFIX = 'fd_ws_cache'; // cualquier versión arranca con esto

/**
 * Dueño de un snapshot. `userId` es `auth.users.id` (el `auth_user_id` del
 * perfil): identifica a la PERSONA de la sesión, no la fila de company_users.
 */
export interface SnapshotScope {
  userId: string;
  companyId: string;
}

function cacheKey(scope: SnapshotScope): string {
  return `${KEY_PREFIX}_v${CACHE_VERSION}_${scope.userId}_${scope.companyId}`;
}

function scopeIsUsable(scope: SnapshotScope | null | undefined): scope is SnapshotScope {
  return !!scope && !!scope.userId && !!scope.companyId;
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
  /** Dueño del snapshot. Se verifica al hidratar — ver cabecera del archivo. */
  userId?: string;
  companyId?: string;
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
export function saveWorkspaceSnapshot(scope: SnapshotScope, snapshot: WorkspaceSnapshot): void {
  if (!hasLocalStorage() || !scopeIsUsable(scope)) return;
  const envelope: StoredEnvelope = {
    savedAt: Date.now(),
    userId: scope.userId,
    companyId: scope.companyId,
    data: snapshot,
  };
  try {
    window.localStorage.setItem(cacheKey(scope), JSON.stringify(envelope));
  } catch (err) {
    // QuotaExceededError (u otro fallo de escritura): liberar espacio
    // borrando TODOS los snapshots (cualquier versión) y no reintentar.
    // El próximo load exitoso volverá a escribir.
    console.warn('[workspace-cache] No se pudo guardar el snapshot, limpiando caché:', err);
    clearWorkspaceCache();
  }
}

/**
 * Devuelve el snapshot cacheado para ESTE usuario en ESTA empresa, o null si
 * no existe, es de otra versión (clave distinta), tiene más de 24h, está
 * corrupto, o **no le pertenece al usuario de la sesión actual**.
 *
 * La verificación de propiedad es el segundo candado (el primero es la clave):
 * un snapshot cuyo sobre diga otro userId/companyId se descarta Y se borra,
 * pase lo que pase con la clave.
 */
export function loadWorkspaceSnapshot(scope: SnapshotScope): WorkspaceSnapshot | null {
  if (!hasLocalStorage() || !scopeIsUsable(scope)) return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(scope));
    if (!raw) return null;
    const envelope = JSON.parse(raw) as StoredEnvelope | null;
    if (!envelope || typeof envelope !== 'object') return null;
    if (typeof envelope.savedAt !== 'number' || !envelope.data || typeof envelope.data !== 'object') {
      return null;
    }
    // Candado 2 — propiedad. Un sobre sin dueño (o con otro dueño) NO hidrata:
    // datos financieros de una persona no se pintan en la sesión de otra.
    if (envelope.userId !== scope.userId || envelope.companyId !== scope.companyId) {
      try { window.localStorage.removeItem(cacheKey(scope)); } catch { /* no-op */ }
      return null;
    }
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) {
      // Vencido — borrarlo para no re-parsearlo en cada load.
      try { window.localStorage.removeItem(cacheKey(scope)); } catch { /* no-op */ }
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
 * usuario, cualquier empresa).
 *
 * Se llama en el LOGOUT EXPLÍCITO (la persona apretó "Cerrar sesión"), no en
 * el auto-logout por inactividad — ver src/lib/auth-context.tsx. Datos
 * financieros no deben sobrevivir a alguien que se va de una máquina
 * compartida; pero quien dejó la pestaña abierta 2h y vuelve es la MISMA
 * persona, y tirarle el caché la condenaba a un arranque frío cada tarde.
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
