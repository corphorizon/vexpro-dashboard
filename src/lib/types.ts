export interface Company {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  logo_url: string | null;
  /** Optional white/monochrome logo for use on dark backgrounds (sidebar).
   *  Falls back to logo_url when null. */
  logo_url_white: string | null;
  /** Isotipo cuadrado (migración 072) para superficies angostas: el sidebar
   *  contraído. Null = se muestra la inicial del nombre. */
  logo_icon_url: string | null;
  /** Rótulo comercial del módulo hedge_fund (migración 126). Vex Pro = «Vex
   *  Capital». null = nombre genérico del módulo. */
  hedge_fund_label?: string | null;
  color_primary: string;
  color_secondary: string;
  currency: string;
  active_modules: string[];
  /**
   * 'broker' (default) opera cuentas de clientes; 'company' factura servicios.
   * Qué apaga cada uno vive en src/lib/business-model.ts — acá solo viaja el
   * valor.
   */
  business_model: string;
  /** Tenant-specific Coinsbuy wallet to pre-select in /movimientos.
   *  Null = UI picks the first wallet returned by the API. */
  default_wallet_id: string | null;
}

export interface Period {
  id: string;
  company_id: string;
  year: number;
  month: number;
  label: string | null;
  is_closed: boolean;
  /**
   * Insumos congelados al cerrar (migración 061). Cuando el período está
   * cerrado, la cadena usa ESTO y no las tablas vivas — ver
   * src/lib/distribution-snapshot.ts.
   */
  closing_snapshot?: import('./distribution-snapshot').ClosingSnapshot | null;
  reserve_pct: number;
}

export interface Deposit {
  id: string;
  period_id: string;
  company_id: string;
  /**
   * Canal del depósito. 'paypros' se agregó el 2026-08-31 junto con la
   * migración 105 (que amplía el CHECK de `deposits.channel`): hasta que esa
   * migración esté aplicada, la carga MANUAL de ese canal la rechaza la base
   * — por eso /upload todavía no lo ofrece. La lectura de la API no depende
   * de la migración: sale de `api_transactions`. Registro de canales en
   * `src/lib/deposit-channels.ts`.
   */
  channel: 'coinsbuy' | 'fairpay' | 'unipayment' | 'paypros' | 'other';
  amount: number;
  notes: string | null;
}

export interface Withdrawal {
  id: string;
  period_id: string;
  company_id: string;
  category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other';
  amount: number;
  notes: string | null;
  description?: string | null;
}

export interface PropFirmSale {
  id: string;
  period_id: string;
  company_id: string;
  amount: number;
}

export interface P2PTransfer {
  id: string;
  period_id: string;
  company_id: string;
  amount: number;
}

export interface Expense {
  id: string;
  period_id: string;
  company_id: string;
  concept: string;
  amount: number;
  paid: number;
  pending: number;
  category: string | null;
  sort_order: number;
  is_fixed?: boolean;
  // Fecha específica del egreso (migration-056), 'YYYY-MM-DD'.
  // null = "sin fecha específica, cuenta para el mes del período" — que es el
  // estado de todas las filas anteriores a la feature. Nunca se rellena con
  // una fecha inventada; vacío en la UI se guarda como null.
  expense_date?: string | null;
  // Orden de pago que originó este egreso (null = egreso cargado a mano).
  // Se setea al marcar pagada una OP y sirve para linkear el egreso al detalle
  // de la orden desde Egresos. OJO: replace_period_expenses borra y re-inserta
  // el período entero desde el payload del cliente — si esta columna no viaja
  // en ese payload, el vínculo se pierde en el próximo guardado.
  payment_order_id?: string | null;

  // Traza del pago (migration-060). Misma pareja que en las órdenes de pago:
  // referencia en texto (hash, nº de operación o link) y archivo adjunto.
  // Cuando el egreso nace de una OP se heredan de esa orden.
  //
  // MISMA TRAMPA que expense_date y payment_order_id: replace_period_expenses
  // borra y re-inserta el período entero desde el payload del cliente. Si
  // estos campos no viajan ahí, se pierden en el próximo guardado del mes.
  reference?: string | null;
  /** Bucket del adjunto: 'expense-attachments' o 'payment-proofs' si vino de una OP. */
  attachment_bucket?: string | null;
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  attachment_size?: number | null;
  attachment_uploaded_at?: string | null;
}

export interface ExpenseTemplate {
  id: string;
  company_id: string;
  concept: string;
  amount: number;
  active: boolean;
  sort_order: number;
  // Vigencia (migration-050): primer año/mes en que la plantilla aplica.
  // null = "siempre" (plantillas creadas antes de la feature). Una
  // plantilla nueva se crea con la vigencia = período actual, así que no
  // se materializa en meses anteriores.
  effective_from_year: number | null;
  effective_from_month: number | null;
}

// Ocultamiento por período (migration-050). La existencia de una fila
// significa "esta plantilla está oculta en ESTE período". Permite esconder
// un fijo en un mes puntual sin afectar los demás.
export interface ExpenseTemplateHidden {
  id: string;
  company_id: string;
  template_id: string;
  period_id: string;
}

export interface ChannelBalance {
  id: string;
  company_id: string;
  snapshot_date: string; // YYYY-MM-DD
  channel_key: string;   // 'coinsbuy' | 'fairpay' | 'wallet_externa' | 'otros' | ...
  amount: number;
  source: 'manual' | 'api' | 'derived';
  notes: string | null;
  /**
   * Desglose del snapshot (migración 085). Para una ubicación on-chain trae
   * cuánto había en cada red y en cada activo, con el precio usado para valuar
   * el gas — de acá sale el detalle por moneda de la tarjeta de Balances, sin
   * volver a consultar la cadena al abrir la página.
   */
  meta?: OnchainSnapshotMeta | Record<string, unknown> | null;
}

/** Lo que el cron guarda en `channel_balances.meta` para una wallet on-chain. */
export interface OnchainSnapshotMeta {
  kind: 'onchain';
  total: number;
  /** Cuándo se leyó el precio del gas. */
  priceAt: string | null;
  /** Cuándo se leyó la cadena. */
  readAt: string;
  networks: Array<{
    network: string;
    address: string;
    usdt: number;
    native: { symbol: string; amount: number; priceUsd: number | null; valueUsd: number };
    subtotal: number;
  }>;
}

export interface PinnedCoinsbuyWallet {
  id: string;
  company_id: string;
  wallet_id: string;
  wallet_label: string;
  /**
   * Migración 084 — qué significa tener esta wallet pineada:
   *   · 'operating' → cuenta como depósitos/retiros de clientes Y suma al balance
   *   · 'internal'  → SOLO suma al balance (ahorro, pago de egresos, tesorería)
   * Las filas anteriores a la migración se leen como 'operating'
   * (`normalizePinnedWalletRole` en src/lib/pinned-wallets.ts).
   */
  role: import('./pinned-wallet-roles').PinnedWalletRole;
  created_at: string;
}

export interface PreoperativeExpense {
  id: string;
  company_id: string;
  concept: string;
  amount: number;
  paid: number;
  pending: number;
  sort_order: number;
}

export interface OperatingIncome {
  id: string;
  period_id: string;
  company_id: string;
  prop_firm: number;
  broker_pnl: number;
  other: number;
}

export interface BrokerBalance {
  id: string;
  period_id: string;
  company_id: string;
  pnl_book_b: number;
  liquidity_commissions: number;
}

export interface FinancialStatus {
  id: string;
  period_id: string;
  company_id: string;
  operating_expenses_paid: number;
  net_total: number;
  previous_month_balance: number;
  current_month_balance: number;
}

export interface Partner {
  id: string;
  company_id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  percentage: number;
}

export interface PartnerDistribution {
  id: string;
  period_id: string;
  partner_id: string;
  company_id: string;
  percentage: number;
  amount: number;
}

export interface LiquidityMovement {
  id: string;
  company_id: string;
  date: string;
  user_email: string | null;
  mt_account: string | null;
  deposit: number;
  withdrawal: number;
  balance: number;
  notes: string | null;
}

export interface Investment {
  id: string;
  company_id: string;
  date: string;
  concept: string | null;
  responsible: string | null;
  deposit: number;
  withdrawal: number;
  profit: number;
  balance: number;
  /**
   * Tipo de movimiento (migración 062). Null en filas viejas — la UI lo
   * infiere con inferMovementType(). Ver src/lib/investment-types.ts.
   */
  movement_type?: string | null;
}

// Computed types for the dashboard
export interface PeriodSummary {
  period: Period;
  totalDeposits: number;
  totalWithdrawals: number;
  netDeposit: number;
  propFirmSales: number;
  propFirmNetIncome: number;
  /**
   * Sum of `investments.profit` for rows whose `date` falls in this period's
   * calendar month. Added to Ingresos Operativos by Resumen General /
   * Socios / admin-home — investments generated this month count toward
   * operating income.
   */
  investmentProfits: number;
  brokerDeposits: number;
  p2pTransfer: number;
  totalExpenses: number;
  totalExpensesPaid: number;
  totalExpensesPending: number;
  operatingIncome: OperatingIncome | null;
  brokerBalance: BrokerBalance | null;
  financialStatus: FinancialStatus | null;
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  expenses: Expense[];
}

// HR Types
/**
 * Los roles conocidos salen del registro único (src/lib/hr/domain.ts) — acá
 * había una quinta copia del literal. El `(string & {})` se queda: el CHECK de
 * `commercial_profiles.role` se eliminó en la migración 011 y pueden aparecer
 * roles libres, que el registro sabe mostrar capitalizados.
 */
export type CommercialRole = import('./hr/domain').HrCommercialRole | (string & {});

export interface Employee {
  id: string;
  company_id: string;
  name: string;
  email: string;
  position: string;
  department: string;
  start_date: string;
  salary: number | null;
  status: 'active' | 'inactive' | 'probation';
  phone: string | null;
  country: string | null;
  notes: string | null;
  birthday: string | null;
  supervisor: string | null;
  comments: string | null;
}

export interface CommercialProfile {
  id: string;
  company_id: string;
  name: string;
  email: string;
  role: CommercialRole;
  head_id: string | null; // who they report to (null for sales_manager/independent heads)
  net_deposit_pct: number | null; // null = N/A
  pnl_pct: number | null; // null = N/A
  commission_per_lot: number | null; // USD per lot, null = N/A
  salary: number | null; // monthly USD, null = N/A
  fixed_salary?: boolean; // true = salary fijo (no depende de ND), false = auto por tiers
  pnl_special_mode?: boolean; // true = modo PnL alternativo (sin división ni acumulado, pero con resta de lotes)
  contract_url?: string | null; // URL del contrato firmado en Supabase Storage
  extra_pct: number | null; // extra differential % for HEAD when head_pct == bdm_pct
  // ── BDM GLOBAL — campos extra del HEAD/Sales Manager ──
  // % que el HEAD cobra sobre el ND de cada BDM GLOBAL en su estructura.
  pct_sobre_bdm_global?: number;
  // % que el HEAD cobra sobre la suma de ND de los BDMs de un HEAD bajo su
  // estructura que tiene salario fijo (ver apply_pct_extra_to_head_without_salary).
  pct_extra_sobre_head?: number;
  // Si true, aplica pct_extra_sobre_head también a HEADs bajo su estructura
  // que NO tienen salario fijo.
  apply_pct_extra_to_head_without_salary?: boolean;
  benefits: string | null;
  comments: string | null;
  hire_date: string | null;
  termination_date: string | null; // fecha de despido (null = no despedido)
  termination_reason: string | null;   // texto libre con los detalles
  termination_category: string | null; // 'performance' | 'misconduct' | 'voluntary' | 'restructuring' | 'other' | null
  terminated_by: string | null;        // auth.users.id de quien ejecutó el despido
  birthday: string | null;
  status: 'active' | 'inactive';
}

// ─── Termination categories (CHECK constraint en DB) ───
export type TerminationCategory = 'performance' | 'misconduct' | 'voluntary' | 'restructuring' | 'other';

export const TERMINATION_CATEGORIES: TerminationCategory[] = [
  'performance', 'misconduct', 'voluntary', 'restructuring', 'other',
];

export interface CommercialMonthlyResult {
  id: string;
  profile_id: string;
  period_id: string;
  net_deposit_current: number;
  net_deposit_accumulated: number;
  net_deposit_total: number;
  pnl_current: number;
  pnl_accumulated: number;
  pnl_total: number;
  commissions_earned: number;
  bonus: number;
  salary_paid: number;
  total_earned: number;
  // Commission calculator fields
  head_id?: string | null;
  division: number;
  base_amount: number;
  real_payment: number;
  accumulated_out: number;
}

// Check List Onboarding — estado del proceso de contratación por comercial.
export interface OnboardingChecklist {
  id: string;
  company_id: string;
  profile_id: string;
  propuesta: boolean;
  acepto_propuesta: boolean;
  contrato: boolean;
  acepto_contrato: boolean;
  accesos: boolean;
  salario_fijo: number | null; // override; null = usar salary del perfil
  sponsor: string | null;      // override; null = usar HEAD del perfil
  created_at?: string;
  updated_at?: string;
}

export type NegotiationStatus = 'active' | 'closed' | 'pending';

export interface Negotiation {
  id: string;
  company_id: string;
  profile_id: string;
  title: string;
  description: string | null;
  status: NegotiationStatus;
  created_at: string;
  updated_at: string;
}

// UserRole is defined in auth-context.tsx — re-export for convenience
export type { UserRole } from './auth-context';

/**
 * Preferred email language stored in company_users.preferred_language and
 * platform_users.preferred_language (migration-052). Users without a
 * configured preference receive English.
 */
export type PreferredLanguage = 'en' | 'es';

// Email Types
export type EmailType = 'welcome' | 'password_reset' | 'report' | 'notification' | 'login_notification';

export interface SendEmailRequest {
  to: string;
  type: EmailType;
  data: WelcomeEmailData | PasswordResetEmailData | ReportEmailData | NotificationEmailData | LoginNotificationData;
}

export interface WelcomeEmailData {
  userName: string;
}

export interface PasswordResetEmailData {
  resetLink: string;
}

export interface ReportEmailData {
  reportName: string;
  reportPeriod: string;
  reportSummary: string;
}

export interface NotificationEmailData {
  title: string;
  message: string;
}

export interface LoginNotificationData {
  userName: string;
  loginDate: string;
  loginTime: string;
  browser: string;
  ipAddress: string;
  dashboardUrl: string;
}

export interface SendEmailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Etiquetas por defecto de los canales de depósito (castellano). Son el
 * FALLBACK de `depositChannelLabel()` en `src/lib/deposit-channels.ts`, que
 * prefiere la clave i18n `movements.channelLabel.<canal>`.
 */
export const CHANNEL_LABELS: Record<string, string> = {
  coinsbuy: 'Coinsbuy (Crypto)',
  fairpay: 'FairPay (Medio Local)',
  unipayment: 'Unipayment (Tarjeta)',
  paypros: 'Pay-Pros (Medio Local)',
  other: 'Otros Depósitos',
};

/**
 * Castellano fijo. NO se usa directo en pantalla: es el RESPALDO de
 * `withdrawalCategoryLabel` (src/lib/withdrawal-categories.ts), que traduce.
 * Hasta el 2026-08-31 esto se renderizaba tal cual y la tarjeta de Retiros
 * salía en castellano al lado de una de Depósitos traducida.
 */
export const WITHDRAWAL_LABELS: Record<string, string> = {
  ib_commissions: 'Comisiones IB',
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  other: 'Otros',
};

export const MONTH_LABELS: Record<number, string> = {
  1: 'Enero',
  2: 'Febrero',
  3: 'Marzo',
  4: 'Abril',
  5: 'Mayo',
  6: 'Junio',
  7: 'Julio',
  8: 'Agosto',
  9: 'Septiembre',
  10: 'Octubre',
  11: 'Noviembre',
  12: 'Diciembre',
};
