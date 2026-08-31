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

import { blockedReportSections } from '@/lib/business-model';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  REPORT_SECTIONS,
  REPORT_SECTION_COLUMNS,
  allSectionsOn,
  isReportSectionKey,
  type ReportSections,
} from './sections';

/**
 * Columnas que se piden y se escriben en `report_configs`. Las de las secciones
 * salen del registro; las de cadencia son fijas. Antes era el MISMO string de 11
 * columnas copiado en el loader y en el upsert.
 */
const CONFIG_COLUMNS = [
  ...REPORT_SECTION_COLUMNS,
  'cadence_daily_enabled',
  'cadence_weekly_enabled',
  'cadence_monthly_enabled',
  'cadence_disabled_users',
  'updated_at',
  'updated_by',
].join(', ');

// `ReportSections` y sus defaults salen del registro único
// (src/lib/reports/sections.ts). Estaban escritos acá, en email-template.ts, en
// pdf.ts (dos veces), en el panel, en el modal de envío y en dos rutas: siete
// copias de las mismas cinco claves. Se re-exporta el tipo para no romper a los
// que ya lo importaban de este módulo.
export type { ReportSections, ReportSectionKey } from './sections';

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
  sections: allSectionsOn(),
  cadences: {
    daily: true,
    weekly: true,
    monthly: true,
  },
  cadenceDisabledUsers: { daily: [], weekly: [], monthly: [] },
  updatedAt: null,
  updatedBy: null,
};

type Row = Record<string, unknown> & {
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
  // La columna de cada sección sale del registro: `include_<clave>` ya no se
  // escribe cinco veces y una columna nueva no exige tocar este mapeo.
  const sections = {} as ReportSections;
  for (const def of REPORT_SECTIONS) {
    sections[def.key] = row[def.column] !== false;
  }
  return {
    sections,
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
  const [configRes, companyRes] = await Promise.all([
    admin
      .from('report_configs')
      .select(CONFIG_COLUMNS)
      .eq('company_id', companyId)
      .maybeSingle(),
    admin.from('companies').select('business_model').eq('id', companyId).maybeSingle(),
  ]);

  const config = configRes.error || !configRes.data
    ? DEFAULT_REPORT_CONFIG
    : rowToConfig(configRes.data as unknown as Row);

  // El modelo de negocio manda sobre la configuración: mandarle a una
  // consultora "Depósitos y retiros: $0" todos los días es peor que no
  // mandarle nada, y su config podría tenerlo encendido por el default.
  const blocked = blockedReportSections(companyRes.data?.business_model);
  if (blocked.length === 0) return config;

  const sections = { ...config.sections };
  for (const key of blocked) {
    if (isReportSectionKey(key)) sections[key] = false;
  }
  return { ...config, sections };
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
        ...Object.fromEntries(
          REPORT_SECTIONS.map((def) => [def.column, input.sections[def.key]]),
        ),
        cadence_daily_enabled: input.cadences.daily,
        cadence_weekly_enabled: input.cadences.weekly,
        cadence_monthly_enabled: input.cadences.monthly,
        cadence_disabled_users: input.cadenceDisabledUsers ?? EMPTY_CADENCE_DISABLED_USERS,
        updated_at: new Date().toISOString(),
        updated_by: input.updatedBy,
      },
      { onConflict: 'company_id' },
    )
    .select(CONFIG_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? 'No se pudo guardar la configuración de reportes');
  }
  return rowToConfig(data as unknown as Row);
}
