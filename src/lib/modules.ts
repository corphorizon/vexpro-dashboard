// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de módulos de la plataforma.
//
// Antes esta lista existía cuatro veces —  ALL_MODULES y MODULE_LABELS en
// auth-context, VALID_MODULE_KEYS en /api/admin/update-company-user y MODULES
// en el formulario de empresa del superadmin — y se desincronizaron:
//
//   · `payment_orders` faltaba en MODULE_LABELS → en /usuarios el chip
//     mostraba la clave cruda y el panel de roles ni siquiera lo ofrecía.
//   · `ib_rebates` faltaba en VALID_MODULE_KEYS → el endpoint lo DESCARTABA
//     al guardar. Seis usuarios ya lo tenían asignado y lo perdían en
//     silencio la próxima vez que alguien editara su ficha.
//
// Por eso la lista vive acá y todos importan de este archivo. Agregar un
// módulo es agregar una fila; no hay una segunda lista que actualizar.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModuleDef {
  key: string;
  labelEs: string;
  labelEn: string;
  /**
   * Submódulo: se asigna por separado en allowed_modules pero vive dentro de
   * la pantalla de otro módulo (hoy solo `ib_rebates`, una pestaña de RRHH).
   * No aparece como destino propio en el menú.
   */
  parent?: string;
}

export const MODULES: ModuleDef[] = [
  { key: 'summary',        labelEs: 'Resumen',            labelEn: 'Summary' },
  { key: 'movements',      labelEs: 'Movimientos',        labelEn: 'Movements' },
  { key: 'expenses',       labelEs: 'Egresos',            labelEn: 'Expenses' },
  { key: 'liquidity',      labelEs: 'Liquidez',           labelEn: 'Liquidity' },
  { key: 'investments',    labelEs: 'Inversiones',        labelEn: 'Investments' },
  { key: 'balances',       labelEs: 'Balances',           labelEn: 'Balances' },
  { key: 'partners',       labelEs: 'Socios',             labelEn: 'Partners' },
  { key: 'payment_orders', labelEs: 'Órdenes de Pago',    labelEn: 'Payment Orders' },
  { key: 'upload',         labelEs: 'Carga de Datos',     labelEn: 'Data Upload' },
  { key: 'periods',        labelEs: 'Períodos',           labelEn: 'Periods' },
  { key: 'reports',        labelEs: 'Reportes',           labelEn: 'Reports' },
  { key: 'hr',             labelEs: 'Recursos Humanos',   labelEn: 'Human Resources' },
  { key: 'ib_rebates',     labelEs: 'Configuración IBs',  labelEn: 'IB Settings', parent: 'hr' },
  { key: 'commissions',    labelEs: 'Comisiones',         labelEn: 'Commissions' },
  { key: 'risk',           labelEs: 'Gestión de Riesgo',  labelEn: 'Risk Management' },
  { key: 'users',          labelEs: 'Usuarios',           labelEn: 'Users' },
  { key: 'logs',           labelEs: 'Registro de Actividad', labelEn: 'Activity Log' },
];

/**
 * `audit` NO está en la lista: es exclusivo del superadmin y hasModuleAccess
 * lo rechaza siempre, incluso para un admin de empresa. Se audita desde
 * /superadmin/companies/[id].
 *
 * `settings` tampoco: quedó de cuando existía el grupo "Configuraciones" en
 * el menú. Ningún usuario lo tiene asignado (verificado en producción) y no
 * hay ninguna pantalla detrás.
 */
export const RESERVED_MODULE_KEYS = ['audit', 'settings'] as const;

export const MODULE_KEYS: string[] = MODULES.map((m) => m.key);

/** Para validar payloads: cualquier clave fuera de acá se descarta. */
export const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS);

/** Etiquetas en español — las consume la UI del dashboard. */
export const MODULE_LABELS: Record<string, string> = Object.fromEntries(
  MODULES.map((m) => [m.key, m.labelEs]),
);

export function moduleLabel(key: string, locale: 'es' | 'en' = 'es'): string {
  const def = MODULES.find((m) => m.key === key);
  if (!def) return key;
  return locale === 'en' ? def.labelEn : def.labelEs;
}

export function isValidModuleKey(key: string): boolean {
  return MODULE_KEY_SET.has(key);
}

/** Filtra un payload dejando solo claves conocidas, sin duplicados. */
export function sanitizeModuleKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw === 'string' && MODULE_KEY_SET.has(raw)) seen.add(raw);
  }
  return [...seen];
}
