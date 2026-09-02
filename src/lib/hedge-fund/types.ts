// ─────────────────────────────────────────────────────────────────────────────
// Tipos del espejo del hedge fund (migración 125).
//
// Igual que en `crm-sync/types.ts`: estas filas son EL CONTRATO con las tablas
// `crm_hf_*`. Una propiedad que no exista como columna hace que PostgREST
// rechace el LOTE ENTERO, no la fila — así que agregar un campo acá obliga a
// agregar la columna en la migración.
// ─────────────────────────────────────────────────────────────────────────────

export type MongoDoc = Record<string, unknown>;

interface Espejo {
  company_id: string;
  raw: Record<string, unknown>;
  /** La corrida que vio esta fila EN EL CRM. Ver la cabecera de la 125. */
  synced_at: string;
}

export interface HfFundRow extends Espejo {
  fund_key: string;
  name: string | null;
  subtitle: string | null;
  strategy: string | null;
  min_investment: number | null;
  holding_months: number | null;
  expected_return_raw: string | null;
  expected_return_min_pct: number | null;
  expected_return_max_pct: number | null;
  risk: string | null;
  currency: string | null;
  enabled: boolean | null;
  status: string | null;
  approval_mode: string | null;
  close_date: string | null;
  slots_total: number | null;
  profits_locked: boolean | null;
  min_remaining_balance: number | null;
  source_created_at: string | null;
  source_updated_at: string | null;
}

export interface HfInvestmentRow extends Espejo {
  investment_id: string;
  ref: string | null;
  user_external_id: string | null;
  fund_key: string | null;
  program: string | null;
  invested: number | null;
  principal: number | null;
  balance: number | null;
  currency: string | null;
  holding_months: number | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  accepted_tc: boolean | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
}

export interface HfLedgerRow extends Espejo {
  entry_id: string;
  investment_id: string | null;
  user_external_id: string | null;
  fund_key: string | null;
  type: string | null;
  amount: number | null;
  balance_before: number | null;
  balance_after: number | null;
  currency: string | null;
  payout_id: string | null;
  description: string | null;
  source_created_at: string | null;
}

export interface HfPayoutRow extends Espejo {
  payout_id: string;
  fund_key: string | null;
  program: string | null;
  percent: number | null;
  status: string | null;
  accounts_affected: number | null;
  total_credited: number | null;
  currency: string | null;
  executed_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  source_created_at: string | null;
}

export interface HfCommissionRow extends Espejo {
  commission_id: string;
  type: string | null;
  beneficiary_user_external_id: string | null;
  beneficiary_username: string | null;
  source_user_external_id: string | null;
  source_username: string | null;
  investment_id: string | null;
  fund_key: string | null;
  level: number | null;
  percent: number | null;
  base_amount: number | null;
  amount: number | null;
  currency: string | null;
  /** 'YYYY-MM' sólo en las RECURRING. NULL en las DIRECT: no es un hueco. */
  ym: string | null;
  status: string | null;
  paid_at: string | null;
  source_created_at: string | null;
}

export interface HfWithdrawalRequestRow extends Espejo {
  request_id: string;
  investment_id: string | null;
  user_external_id: string | null;
  fund_key: string | null;
  status: string | null;
  type: string | null;
  amount: number | null;
  currency: string | null;
  requested_at: string | null;
  processed_at: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
}

export interface HfMonthlyReturnRow extends Espejo {
  fund_key: string;
  ym: string;
  percent: number | null;
  amount: number | null;
}

export interface HfCertificateRow extends Espejo {
  certificate_id: string;
  number: string | null;
  investment_id: string | null;
  user_external_id: string | null;
  investor_name: string | null;
  investment_date: string | null;
  amount: number | null;
  currency: string | null;
  fund_key: string | null;
  program: string | null;
  sent_at: string | null;
  source_created_at: string | null;
}

/** Un nivel de la config de comisiones, ya normalizado y ordenado. */
export interface HfCommissionLevel {
  level: number;
  percent: number;
  /** Sólo en los recurrentes. `null` en los directos: no es 0 meses. */
  months: number | null;
}

/**
 * La configuración de comisiones tal como la deja el vigilante.
 * `fingerprint` es lo ÚNICO que se compara entre corridas.
 */
export interface HfCommissionConfig {
  fingerprint: string;
  directLevels: HfCommissionLevel[];
  recurringLevels: HfCommissionLevel[];
  maxLevels: number | null;
  sourceUpdatedAt: string | null;
  updatedBy: string | null;
  raw: Record<string, unknown>;
}

/** Conteos por tabla que devuelve el sync. */
export interface HfTableStats {
  /** Documentos leídos del CRM. */
  fetched: number;
  /** Filas escritas en Supabase. */
  upserted: number;
  /** Documentos descartados por ser de PRUEBA. Contados, nunca silenciados. */
  excluded: number;
  /**
   * Filas de nuestro espejo que esta corrida NO vio en el CRM. No se borran:
   * se cuentan. Una desaparición silenciosa es indistinguible de un cruce roto.
   */
  unseen: number;
}

export interface HedgeFundSyncResult {
  companyId: string;
  ranAt: string;
  funds: HfTableStats;
  investments: HfTableStats;
  ledgerEntries: HfTableStats;
  payouts: HfTableStats;
  commissions: HfTableStats;
  withdrawalRequests: HfTableStats;
  monthlyReturns: HfTableStats;
  certificates: HfTableStats;
  /**
   * `null` = la configuración no cambió (o es la primera vez que se ve, en
   * cuyo caso `before` es null y `after` el snapshot inicial).
   */
  configChanged: { before: HfCommissionConfig | null; after: HfCommissionConfig } | null;
  /** Total de documentos excluidos por prueba, sumando todas las tablas. */
  excludedTotal: number;
  elapsedMs: number;
  warnings: string[];
  errors: string[];
}
