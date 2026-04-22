// ─────────────────────────────────────────────────────────────────────────────
// Report configuration (per-company).
//
// Stored in the `report_configs` table (migration 034). One row per company,
// a missing row means "everything on" — so adding the table is a no-op for
// companies that have not customised anything yet.
//
// Three concerns live here:
//   1. Shape + defaults
//   2. Server-side loader (used by the cron + the reportes page)
//   3. Upsert helper (used by /api/reports/config)
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';

export interface ReportSections {
  deposits_withdrawals: boolean;
  balances_by_channel: boolean;
  crm_users: boolean;
  broker_pnl: boolean;
  prop_trading: boolean;
}

export interface ReportCadences {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
}

/**
 * Per-cadence lists of company_users.id values that should NOT receive
 * that cadence. Stored in the `cadence_disabled_users` jsonb column. A
 * user absent from every list receives every enabled cadence.
 */
export interface CadenceDisabledUsers {
  daily: string[];
  weekly: string[];
  monthly: string[];
}

export const EMPTY_CADENCE_DISABLED_USERS: CadenceDisabledUsers = {
  daily: [],
  weekly: [],
  monthly: [],
};

export interface ReportConfig {
  sections: ReportSections;
  cadences: ReportCadences;
  cadenceDisabledUsers: CadenceDisabledUsers;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  sections: {
    deposits_withdrawals: true,
    balances_by_channel: true,
    crm_users: true,
    broker_pnl: true,
    prop_trading: true,
  },
  cadences: {
    daily: true,
    weekly: true,
    monthly: true,
  },
  cadenceDisabledUsers: { daily: [], weekly: [], monthly: [] },
  updatedAt: null,
  updatedBy: null,
};

type Row = {
  include_deposits_withdrawals: boolean;
  include_balances_by_channel: boolean;
  include_crm_users: boolean;
  include_broker_pnl: boolean;
  include_prop_trading: boolean;
  cadence_daily_enabled: boolean;
  cadence_weekly_enabled: boolean;
  cadence_monthly_enabled: boolean;
  cadence_disabled_users: unknown;
  updated_at: string | null;
  updated_by: string | null;
};

function normalizeDisabled(raw: unknown): CadenceDisabledUsers {
  const out: CadenceDisabledUsers = { daily: [], weekly: [], monthly: [] };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const k of ['daily', 'weekly', 'monthly'] as const) {
    const v = obj[k];
    if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}

function rowToConfig(row: Row): ReportConfig {
  return {
    sections: {
      deposits_withdrawals: row.include_deposits_withdrawals,
      balances_by_channel: row.include_balances_by_channel,
      crm_users: row.include_crm_users,
      broker_pnl: row.include_broker_pnl,
      prop_trading: row.include_prop_trading,
    },
    cadences: {
      daily: row.cadence_daily_enabled,
      weekly: row.cadence_weekly_enabled,
      monthly: row.cadence_monthly_enabled,
    },
    cadenceDisabledUsers: normalizeDisabled(row.cadence_disabled_users),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Load a company's report config. Never throws: on any error returns the
 * default ("all on"). Used by the cron (so a bad row can't take down the
 * daily mailer) and by the reportes page.
 */
export async function loadReportConfig(companyId: string): Promise<ReportConfig> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('report_configs')
    .select(
      'include_deposits_withdrawals, include_balances_by_channel, include_crm_users, include_broker_pnl, include_prop_trading, cadence_daily_enabled, cadence_weekly_enabled, cadence_monthly_enabled, cadence_disabled_users, updated_at, updated_by',
    )
    .eq('company_id', companyId)
    .maybeSingle();
  if (error || !data) return DEFAULT_REPORT_CONFIG;
  return rowToConfig(data as Row);
}

export interface SaveReportConfigInput {
  companyId: string;
  updatedBy: string;
  sections: ReportSections;
  cadences: ReportCadences;
  cadenceDisabledUsers?: CadenceDisabledUsers;
}

export async function saveReportConfig(input: SaveReportConfigInput): Promise<ReportConfig> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('report_configs')
    .upsert(
      {
        company_id: input.companyId,
        include_deposits_withdrawals: input.sections.deposits_withdrawals,
        include_balances_by_channel: input.sections.balances_by_channel,
        include_crm_users: input.sections.crm_users,
        include_broker_pnl: input.sections.broker_pnl,
        include_prop_trading: input.sections.prop_trading,
        cadence_daily_enabled: input.cadences.daily,
        cadence_weekly_enabled: input.cadences.weekly,
        cadence_monthly_enabled: input.cadences.monthly,
        cadence_disabled_users: input.cadenceDisabledUsers ?? EMPTY_CADENCE_DISABLED_USERS,
        updated_at: new Date().toISOString(),
        updated_by: input.updatedBy,
      },
      { onConflict: 'company_id' },
    )
    .select(
      'include_deposits_withdrawals, include_balances_by_channel, include_crm_users, include_broker_pnl, include_prop_trading, cadence_daily_enabled, cadence_weekly_enabled, cadence_monthly_enabled, cadence_disabled_users, updated_at, updated_by',
    )
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? 'No se pudo guardar la configuración de reportes');
  }
  return rowToConfig(data as Row);
}
