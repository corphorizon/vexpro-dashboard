// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de los conceptos de `wallettransfers` (Orion).
//
// ── POR QUÉ ESTE ARCHIVO EXISTE ────────────────────────────────────────────
// La lista vivía dentro de `crm-sync/wallet-sources.ts`, que es `server-only`
// (arrastra el lector de Mongo). Cuando los totales mensuales informativos
// (comisiones IB, social trading fees, fee debt recovery) necesitaron la
// MISMA lista desde el núcleo puro y desde los tests, había dos caminos:
// copiarla —el modo de falla número uno de este repo— o mudarla a un módulo
// puro. Se mudó. `wallet-sources.ts` la reexporta para que nada de lo que ya
// importaba `CONCEPT_GROUPS` desde allá tenga que cambiar.
//
// ── POR QUÉ UN OBJETO Y NO UN STRING POR CONCEPTO ──────────────────────────
// El grupo solo no alcanzaba. Dentro de 'social' conviven dos cosas que NO
// son la misma: el fee que se le acredita al gestor (SOCIAL_PERFORMANCE_FEE,
// _SHARE, SOCIAL_SUBSCRIPTION_SHARE) y el REVERSO de un fee mal cobrado
// (PERFORMANCE_FEE_REVERSAL y su ajuste — los 35 movimientos del 2026-07-26
// que dicen, en su propio `internalNote`, "Reverso perf-fee fantasma (bug
// balance EOD congelado en retiro, fix eb3dd1a1)"). Sumar el reverso al fee
// da $144.596,58 donde el fee cobrado fue $142.965,68. La distinción se
// escribe acá una vez, con `kind`, en vez de repetir listas de literales en
// cada consumidor.
//
// ── LOS NOMBRES SALEN DE LA BASE ───────────────────────────────────────────
// Medido el 2026-08-28 contra producción: Vex Pro tiene 32 combinaciones
// (concepto × dirección) y AP Markets 19. El broker escribe el ajuste de
// comisiones IB de TRES formas distintas ('IB_REWARDS_BROKER ADJUSTMENT',
// 'IB_REWARDS_BROKER_ADJUSTMENT' e 'IB REWARDS BROKER ADJUSTMENT'): las tres
// están acá porque las tres existen en los documentos, no porque se hayan
// adivinado.
// ─────────────────────────────────────────────────────────────────────────────

/** A qué familia pertenece el concepto. */
export type WalletConceptGroup =
  | 'ib'
  | 'social'
  | 'propfirm'
  | 'trading'
  | 'p2p'
  | 'deposit'
  | 'returned'
  | 'feeDebt'
  | 'withdraw'
  | 'propfirmPurchase'
  | 'hedgeFund';

/**
 * Qué ES el movimiento dentro de su familia.
 *
 * · `credit`   — el hecho principal del grupo (la comisión que se acredita,
 *                el fee que se cobra).
 * · `reversal` — la corrección de un `credit` anterior. NO suma al total del
 *                grupo: se informa aparte para que la diferencia se vea.
 * · `plain`    — el resto, donde la distinción no aplica.
 */
export type WalletConceptKind = 'credit' | 'reversal' | 'plain';

export interface WalletConceptDef {
  group: WalletConceptGroup;
  kind: WalletConceptKind;
}

/**
 * Los tres conceptos del hedge fund, nombrados UNA vez.
 *
 * Se exportan como constantes —y el registro de abajo se arma con ellas— para
 * que la spec de la métrica pueda referirse a cada uno por separado sin
 * escribir el literal por segunda vez. `conceptsOf('hedgeFund', kind)` no
 * alcanza acá: los tres son cosas distintas (capital que sale, rendimiento que
 * entra, capital que vuelve) y cada uno va a su propia columna.
 *
 * Direcciones VERIFICADAS contra los documentos reales el 2026-08-31
 * (`wallettransfers`, censo concepto × dirección):
 *   · HEDGE_FUND_INVEST  OUT — AP Markets 22 mov. $23.928,88 · Vex Pro 1 mov. $3.000
 *   · HEDGE_FUND_REWARD  IN  — AP Markets 23 mov. $927,10 (gross $24.560: el
 *     `grossAmount` es el CAPITAL sobre el que se calculó, no el rendimiento —
 *     mismo patrón que IB_PROP_FIRM_REWARD, donde $22.471 de net conviven con
 *     $633.416 de gross. El dinero es `netAmount`.)
 *   · HEDGE_FUND_REWARD  OUT — AP Markets 3 mov. $926,00 (reverso del anterior)
 *   · HEDGE_FUND_RETURN  IN  — AP Markets 3 mov. $302,00
 * Vex Pro sólo tiene la pata INVEST; por eso su tabla muestra las otras
 * columnas en cero y no "sin datos": la familia entera se leyó y no había más.
 */
export const HEDGE_FUND_CONCEPTS = {
  invest: 'HEDGE_FUND_INVEST',
  reward: 'HEDGE_FUND_REWARD',
  capitalReturn: 'HEDGE_FUND_RETURN',
} as const;

export const WALLET_CONCEPTS: Record<string, WalletConceptDef> = {
  // ── Hedge fund (decisión de Kevin, 2026-08-31) ──────────────────────────
  // Informativo: mueve la BILLETERA del cliente hacia un fondo, no la caja
  // del bróker. Ver el bloque de métricas informativas de `crm-monthly.ts`.
  [HEDGE_FUND_CONCEPTS.invest]: { group: 'hedgeFund', kind: 'credit' },
  [HEDGE_FUND_CONCEPTS.reward]: { group: 'hedgeFund', kind: 'plain' },
  [HEDGE_FUND_CONCEPTS.capitalReturn]: { group: 'hedgeFund', kind: 'plain' },

  // ── Comisiones de IB ────────────────────────────────────────────────────
  IB_REWARDS_BROKER: { group: 'ib', kind: 'credit' },
  IB_PROP_FIRM_REWARD: { group: 'ib', kind: 'credit' },
  'IB_REWARDS_BROKER ADJUSTMENT': { group: 'ib', kind: 'credit' },
  IB_REWARDS_BROKER_ADJUSTMENT: { group: 'ib', kind: 'credit' },
  'IB REWARDS BROKER ADJUSTMENT': { group: 'ib', kind: 'credit' },

  // ── Social trading ──────────────────────────────────────────────────────
  SOCIAL_PERFORMANCE_FEE: { group: 'social', kind: 'credit' },
  SOCIAL_PERFORMANCE_FEE_SHARE: { group: 'social', kind: 'credit' },
  SOCIAL_SUBSCRIPTION_SHARE: { group: 'social', kind: 'credit' },
  PERFORMANCE_FEE_REVERSAL: { group: 'social', kind: 'reversal' },
  PERFORMANCE_FEE_REVERSAL_ADJUSTMENT: { group: 'social', kind: 'reversal' },

  // ── Recupero de fee adeudado ────────────────────────────────────────────
  // Sale de la billetera del cliente (OUT) y su `relatedConceptId` es
  // 'FEE-DEBT-INIT-<cuenta>'. Antes no estaba en el registro y por eso caía
  // en `in_other` de wallet-sources — no molestaba porque no tiene una sola
  // pata IN (0 documentos IN en Vex Pro y en AP Markets el 2026-08-28), pero
  // "no molesta" y "está clasificado" no son lo mismo.
  FEE_DEBT_RECOVERY: { group: 'feeDebt', kind: 'credit' },

  PROP_FIRM_WITHDRAW: { group: 'propfirm', kind: 'plain' },

  // ── Dos flujos que el código YA trataba como de primera clase pero que
  // nunca habían entrado al registro ──────────────────────────────────────
  // El retiro de la billetera (14.096 movimientos por $6.333.580 en Vex Pro)
  // y la pata de billetera de una compra de prop firm (la que ya usa
  // PROPFIRM_PURCHASE_CONCEPT en crm-monthly.ts para contrastar las ventas).
  // Se agregan para que el aviso de "conceptos sin clasificar" señale lo que
  // de verdad es nuevo y no seis líneas de ruido conocido. Sus grupos NO
  // están en el switch de `wallet-sources`, así que siguen cayendo donde
  // caían (`in_other`): agregarlos acá no cambia ni un número.
  WITHDRAW: { group: 'withdraw', kind: 'plain' },
  PROP_FIRM_PURCHASE: { group: 'propfirmPurchase', kind: 'plain' },

  // Dinero que vuelve DE una cuenta de trading a la billetera: es la ganancia
  // (o lo que quede) de operar.
  TRANSFER_FUNDS: { group: 'trading', kind: 'plain' },
  WALLET_TRANSFER: { group: 'trading', kind: 'plain' },

  TRANSFER_P2P: { group: 'p2p', kind: 'plain' },
  DEPOSIT: { group: 'deposit', kind: 'plain' },

  // ── DEVOLUCIONES: dinero que YA ESTABA y volvió ─────────────────────────
  // Un retiro rechazado o cancelado devuelve el importe a la billetera. NO es
  // dinero nuevo: contarlo como ingreso lo duplicaría, porque entró una vez
  // como depósito (o como lo que fuera) antes del intento de retiro.
  // Medido: $455.233 devueltos por rechazo y $676.115 por cancelación.
  REJECTED_WITHDRAW: { group: 'returned', kind: 'plain' },
  CANCELED_WITHDRAW: { group: 'returned', kind: 'plain' },
  CANCELLED_WITHDRAW: { group: 'returned', kind: 'plain' },
  // Reembolso de una suscripción de social trading: misma lógica.
  SOCIAL_SUBSCRIPTION: { group: 'returned', kind: 'plain' },
};

/**
 * La vista "concepto → grupo" de siempre, DERIVADA del registro de arriba.
 * `wallet-sources.ts` la usa tal cual y `monthly-totals.ts` deriva de ella la
 * lista de conceptos P2P.
 */
export const CONCEPT_GROUPS: Record<string, string> = Object.fromEntries(
  Object.entries(WALLET_CONCEPTS).map(([concept, def]) => [concept, def.group]),
);

/** Los conceptos de un grupo, opcionalmente filtrados por `kind`. */
export function conceptsOf(group: WalletConceptGroup, kind?: WalletConceptKind): string[] {
  return Object.entries(WALLET_CONCEPTS)
    .filter(([, def]) => def.group === group && (kind === undefined || def.kind === kind))
    .map(([concept]) => concept);
}

/** `true` si el concepto NO está en el registro. Ver el aviso del sync. */
export function isUnknownConcept(concept: string): boolean {
  return !Object.prototype.hasOwnProperty.call(WALLET_CONCEPTS, concept);
}
