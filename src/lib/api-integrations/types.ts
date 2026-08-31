// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Shared types
//
// Per-provider transaction shapes that match the columns each provider
// returns in its real API response. The breakdown page (/movimientos/desglose)
// renders these directly; the main Movimientos page uses `computeProviderTotals`
// to get the filtered sum that corresponds to each provider's "accepted" status.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = 'coinsbuy' | 'fairpay' | 'unipayment' | 'paypros';
export type FetchStatus = 'fresh' | 'stale' | 'error';

/**
 * Stable slug used in the URL for the breakdown page and in API query params.
 * One slug per card shown on the Movimientos page.
 *
 * `paypros` se sumó el 2026-08-31 (ver la sección Pay-Pros más abajo): sus
 * filas ya vivían en `api_transactions` desde el 22 de julio y
 * `loadPersistedTotals` ya las contaba, pero la pantalla no — la tarjeta
 * «Depósitos» de /movimientos cableaba tres slugs a mano y dejaba afuera
 * $44.653,95. Este union es el registro canónico: agregar un proveedor acá
 * rompe la compilación de todos los `Record<ProviderSlug, …>` exhaustivos,
 * que es exactamente lo que se quiere — el compilador enumera las copias.
 */
export type ProviderSlug =
  | 'coinsbuy-deposits'
  | 'coinsbuy-withdrawals'
  | 'fairpay'
  | 'unipayment'
  | 'paypros';

// ── Coinsbuy ──

export interface CoinsbuyDepositTx {
  id: string;
  provider: 'coinsbuy';
  kind: 'deposit';
  createdAt: string;       // ISO datetime
  label: string;
  trackingId: string;
  commission: number;      // fee charged by Coinsbuy
  amountTarget: number;    // net amount credited (what we sum for totals)
  currency: string;
  status: 'Confirmed' | 'Pending' | 'Failed';
  /** Coinsbuy wallet ID this transfer belongs to (e.g. "1079"). Extracted
   *  from `relationships.wallet.data.id`. Required for the wallet filter
   *  on /movimientos and /movimientos/desglose to work — without it the
   *  filter shows all wallets across the Coinsbuy account. */
  walletId?: string;
  /** Human-readable label resolved from the Coinsbuy /wallet/<id> endpoint
   *  or the tenant's pinned_coinsbuy_wallets row. Persisted alongside
   *  wallet_id so the breakdown table can render "VexPro Main Wallet"
   *  without joining at read time. */
  walletLabel?: string;
  /** Si true, el admin marcó esta transacción como externa (fondeo manual,
   *  swap interno, etc). NO se cuenta en totales y NO se muestra por
   *  defecto en /movimientos. Toggle "Mostrar excluidas" la revela. */
  excluded?: boolean;
  excludedReason?: string;
  excludedByName?: string;
  excludedAt?: string;
}

export interface CoinsbuyWithdrawalTx {
  id: string;
  provider: 'coinsbuy';
  kind: 'withdrawal';
  createdAt: string;
  label: string;
  trackingId: string;
  amount: number;          // requested amount
  chargedAmount: number;   // amount actually deducted (what we sum for totals)
  commission: number;      // chargedAmount - amount (precomputed)
  currency: string;
  status: 'Approved' | 'Pending' | 'Rejected';
  /** See CoinsbuyDepositTx.walletId — same field, same purpose. */
  walletId?: string;
  walletLabel?: string;
  /** Si true, es una transferencia INTERNA entre wallets propias de la
   *  empresa (ej. Savings→Main). Se detecta porque Coinsbuy v3 devuelve
   *  txid null/vacío para los payouts internos (los externos siempre
   *  tienen txid de blockchain al confirmarse). NO cuenta en Retiros
   *  Totales ni en Net Deposit — es plata que nunca salió de la empresa.
   *  Distinto de `excluded` (exclusión manual del admin): `internal` se
   *  marca automáticamente en el fetcher. */
  internal?: boolean;
  /** Si true, el admin marcó esta transacción como externa (retiro
   *  procesado fuera del flow del CRM, swap interno, etc). NO se cuenta
   *  en totales y NO se muestra por defecto en /movimientos. */
  excluded?: boolean;
  excludedReason?: string;
  excludedByName?: string;
  excludedAt?: string;
}

// ── FairPay ──

export interface FairpayDepositTx {
  id: string;
  provider: 'fairpay';
  kind: 'deposit';
  createdAt: string;
  customerEmail: string;
  billed: number;          // gross amount
  mdr: number;             // merchant discount rate (fee)
  net: number;             // billed - mdr (what we sum for totals)
  currency: string;
  status: 'Completed' | 'Pending' | 'Failed';
}

// ── Unipayment ──

export interface UnipaymentDepositTx {
  id: string;
  provider: 'unipayment';
  kind: 'deposit';
  createdAt: string;
  email: string;
  orderId: string;
  grossAmount: number;
  fee: number;
  netAmount: number;       // what we sum for totals
  currency: string;
  status: 'Completed' | 'Pending' | 'Expired';
  /** Full original UniPayment invoice payload, persisted into
   *  api_transactions.raw alongside the processed shape. Used to discover
   *  which fee field name UniPayment actually returns for this merchant
   *  (the fee field name is undocumented / varies by app config). Once a
   *  field is confirmed, `pickFee()` in transactions.ts can be tightened.
   *  Underscore prefix marks it as a debug/inspection field — never
   *  rendered in the UI. */
  _originalResponse?: Record<string, unknown>;
}

// ── Pay-Pros ──
//
// Pay-Pros NO tiene endpoint de listado: no participa del aggregator (la
// llamada en vivo de /movimientos), y por eso `fetchProviderBySlug('paypros')`
// devuelve un dataset en error explícito en vez de inventar una fetch.
//
// Sus filas entran a `api_transactions` con provider='paypros' por DOS vías
// posibles, y hoy solo una está viva:
//   · CRM Orion (`./paypros/deposits-from-crm.ts`) — la fuente REAL desde el
//     2026-08-24: external_id con prefijo `crm:`. Las 61 filas de Vex Pro al
//     2026-08-31 ($44.653,95) vienen todas de acá.
//   · Webhook (`/api/webhooks/paypros/[token]`) — construido y nunca usado
//     (la URL registrada en Pay-Pros es la del CRM). Si algún día llega
//     tráfico, `syncPayprosDepositsFromCrm` lo grita: el mismo depósito por
//     dos claves distintas sería doble conteo.
//
// DESDE 2026-08-31 'paypros' SÍ está en `ProviderSlug` (ver arriba). El
// comentario anterior decía lo contrario y describía cómo sumarlo; esto es
// exactamente ese paso, hecho.
//
// Ver `PAYPROS_PROVIDER` y `toNormalizedTx` en `./paypros/protocol.ts`.

/** Valor que se guarda en api_transactions.provider para Pay-Pros. */
export type PayprosProviderSlug = 'paypros';

/**
 * Estados de Pay-Pros ya traducidos a texto legible. Solo 'paid' (código 4)
 * es un depósito cobrado; 'payout_paid' (6) es un retiro.
 */
export type PayprosTxStatus =
  | 'refund_approved'
  | 'refund_declined'
  | 'paid'
  | 'unpaid'
  | 'payout_paid'
  | 'payout_declined';

export interface PayprosDepositTx {
  /**
   * uid de la transacción en Pay-Pros, o `crm:<depositId>` cuando la fila
   * viene del espejo del CRM (que es el caso de TODAS las filas de hoy).
   */
  id: string;
  provider: 'paypros';
  /**
   * 'deposit' para status 'paid'; 'withdrawal' para 'payout_paid'. No es
   * cosmético: un payout mal marcado como depósito sumaría en vez de restar.
   */
  kind: 'deposit' | 'withdrawal';
  /** ISO UTC (el webhook lo manda en hora de Lima, GMT-5). */
  createdAt: string;
  amount: number;
  currency: string;
  status: PayprosTxStatus;
  /**
   * Id único de la NOTIFICACIÓN que trajo esta transacción (webhook), o el
   * `externalPaymentId` de Orion cuando la fila viene del CRM. Informativo.
   */
  notifyReference: string;
}

// ── Union + dataset ──

export type ProviderTransaction =
  | CoinsbuyDepositTx
  | CoinsbuyWithdrawalTx
  | FairpayDepositTx
  | UnipaymentDepositTx
  | PayprosDepositTx;

export interface ProviderDataset<T extends ProviderTransaction = ProviderTransaction> {
  slug: ProviderSlug;
  provider: ProviderId;
  kind: 'deposits' | 'withdrawals';
  transactions: T[];       // ALL rows (unfiltered) — filter happens in totals helper
  fetchedAt: string;       // ISO timestamp
  status: FetchStatus;
  isMock: boolean;
  errorMessage?: string;
  /**
   * El proveedor no tiene credenciales para este tenant. Va aparte de
   * `status` porque para la UI sigue siendo un 'error' (no hay datos que
   * mostrar), pero para el cron NO lo es: un tenant que no usa FairPay no
   * puede generar avisos de sincronización todos los días.
   */
  notConfigured?: boolean;
}

// ── Totals (filtered by accepted status) ──

export interface ProviderTotals {
  total: number;           // sum of the canonical amount field
  count: number;           // count of accepted transactions
  feeTotal: number;        // sum of fees / commissions
  acceptedStatus: string;  // label of the status we count
}

// ── Config ──

export interface ApiCredentials {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  credentials: ApiCredentials;
}
