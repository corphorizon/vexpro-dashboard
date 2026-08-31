// ─────────────────────────────────────────────────────────────────────────────
// Las cinco secciones del reporte — registro único.
//
// POR QUÉ EXISTE (2026-08-31, auditoría de finanzas, ítem 15)
// Las mismas cinco claves estaban escritas SIETE veces, cada una con su propia
// forma de decir lo mismo:
//
//   1. `reports/config.ts` — la interfaz `ReportSections`, el default "todo
//      encendido", el tipo `Row` de la tabla, el mapeo fila→config y el mapeo
//      config→fila. Cinco enumeraciones en un solo archivo.
//   2. `reports/email-template.ts` — otra interfaz `EmailSections` idéntica y
//      otro default.
//   3. `reports/pdf.ts` — otra interfaz más y DOS defaults (uno "todo on" y otro
//      "sólo lo del bróker").
//   4. `finanzas/reportes/config-panel.tsx` — interfaz, etiquetas en castellano
//      y default.
//   5. `finanzas/reportes/send-modal.tsx` — lo mismo otra vez.
//   6. `api/reports/config/route.ts` — la lista de claves para validar el body.
//   7. `api/reports/send/route.ts` — cinco bloques `typeof x === 'boolean' ? …`
//      copiados, uno por sección.
//
// Y `business-model.ts:190` empuja claves a esa misma lista desde afuera.
//
// Agregar una sección significaba tocar los siete y acertar en los siete. El
// modo de falla que esto habilita no es una excepción: es una sección nueva que
// el panel ofrece, la config guarda… y el mail no manda, porque su interfaz
// local no la conoce y el `?` la deja en `undefined` (falsy). Nadie ve un error.
//
// Acá vive UNA fila por sección, con su columna en la tabla y su etiqueta en los
// dos idiomas. CLIENT-SAFE: no importa Supabase.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportSectionDef {
  key: string;
  /** Columna booleana en `report_configs` (migración 034). */
  column: string;
  labelEs: string;
  labelEn: string;
}

const SECTION_DEFS = [
  {
    key: 'deposits_withdrawals',
    column: 'include_deposits_withdrawals',
    labelEs: 'Depósitos y Retiros',
    labelEn: 'Deposits and withdrawals',
  },
  {
    key: 'balances_by_channel',
    column: 'include_balances_by_channel',
    labelEs: 'Balances por Canal',
    labelEn: 'Balances by channel',
  },
  {
    key: 'crm_users',
    column: 'include_crm_users',
    labelEs: 'Usuarios CRM',
    labelEn: 'CRM users',
  },
  {
    key: 'broker_pnl',
    column: 'include_broker_pnl',
    labelEs: 'P&L Broker',
    labelEn: 'Broker P&L',
  },
  {
    key: 'prop_trading',
    column: 'include_prop_trading',
    labelEs: 'Prop Trading',
    labelEn: 'Prop trading',
  },
] as const satisfies readonly ReportSectionDef[];

export type ReportSectionKey = (typeof SECTION_DEFS)[number]['key'];

// Se exporta el literal, NO `readonly ReportSectionDef[]`: con la anotación
// ancha `def.key` vuelve a ser `string` y se pierde justo lo que hace que
// agregar una sección rompa la compilación en cada consumidor.
export const REPORT_SECTIONS = SECTION_DEFS;

export const REPORT_SECTION_KEYS: readonly ReportSectionKey[] = SECTION_DEFS.map(
  (s) => s.key,
) as ReportSectionKey[];

/**
 * Las columnas de `report_configs`, en el orden del registro. Se usa para armar
 * el `select(...)` del loader y del upsert: eran dos strings de 11 columnas
 * copiados y pegados, y una sección nueva exigía editar los dos.
 */
export const REPORT_SECTION_COLUMNS: readonly string[] = SECTION_DEFS.map((s) => s.column);

/**
 * Qué secciones lleva el reporte. `Record` sobre el union: agregar una fila
 * arriba ROMPE la compilación de cada objeto literal que arme un
 * `ReportSections`, que es donde tiene que romper.
 */
export type ReportSections = Record<ReportSectionKey, boolean>;

/** Todo encendido — el default cuando la empresa no configuró nada. */
export function allSectionsOn(): ReportSections {
  return Object.fromEntries(REPORT_SECTION_KEYS.map((k) => [k, true])) as ReportSections;
}

/** Todo apagado — punto de partida para "sólo estas". */
export function allSectionsOff(): ReportSections {
  return Object.fromEntries(REPORT_SECTION_KEYS.map((k) => [k, false])) as ReportSections;
}

/** Sólo las claves indicadas encendidas. */
export function onlySections(keys: readonly ReportSectionKey[]): ReportSections {
  const out = allSectionsOff();
  for (const k of keys) out[k] = true;
  return out;
}

export function isReportSectionKey(value: unknown): value is ReportSectionKey {
  return typeof value === 'string' && (REPORT_SECTION_KEYS as readonly string[]).includes(value);
}

/**
 * Lee un objeto de secciones que vino de afuera (body de un request, jsonb de
 * la DB, caché del cliente) contra un fallback.
 *
 * Cada clave se toma sólo si vino como booleano; cualquier otra cosa cae al
 * fallback. Era el bloque de cinco ternarios copiados de
 * `api/reports/send/route.ts`, donde una sección nueva se olvidaba en silencio
 * y salía siempre con el valor guardado aunque el usuario la hubiera destildado
 * en el modal.
 */
export function parseReportSections(raw: unknown, fallback: ReportSections): ReportSections {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as ReportSections;
  for (const key of REPORT_SECTION_KEYS) {
    out[key] = typeof obj[key] === 'boolean' ? (obj[key] as boolean) : fallback[key];
  }
  return out;
}

/** Etiqueta de la sección en el idioma pedido. */
export function reportSectionLabel(key: ReportSectionKey, locale: 'es' | 'en' = 'es'): string {
  const def = REPORT_SECTIONS.find((s) => s.key === key);
  if (!def) return key;
  return locale === 'en' ? def.labelEn : def.labelEs;
}

/** `{ clave: etiqueta }` para los paneles que renderizan la lista completa. */
export function reportSectionLabels(locale: 'es' | 'en' = 'es'): Record<ReportSectionKey, string> {
  return Object.fromEntries(
    REPORT_SECTIONS.map((s) => [s.key, locale === 'en' ? s.labelEn : s.labelEs]),
  ) as Record<ReportSectionKey, string>;
}
