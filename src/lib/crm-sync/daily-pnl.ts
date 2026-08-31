// ─────────────────────────────────────────────────────────────────────────────
// El PNL diario TAL COMO LO DA EL CRM.
//
// ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
// El panel de Orion muestra tres números que la gente de la empresa mira todos
// los días — y que hasta hoy el dashboard no tenía:
//
//     Total Records   8.040.861
//     Volume          1.408.428,98
//     Total PNL      -$388.584,65      (mes en curso, captura del 2026-08-31)
//
// Ninguno salía de acá. Lo que el dashboard llamaba "Broker P&L" era otra
// cosa: en /resumen-general es la cifra que alguien teclea en Carga de Datos
// (`incomes.broker_pnl`), y en /finanzas/reportes venía de un endpoint REST
// `/v1/broker-pnl` que Vex Pro NO tiene configurado (el 2026-08-31 la empresa
// tiene ocho credenciales cargadas y `orion_crm` no está entre ellas), así que
// caía al generador de datos falsos. Un número inventado y uno tecleado, los
// dos con el mismo nombre que el número real.
//
// ── DE DÓNDE SALE EL NÚMERO ────────────────────────────────────────────────
// De la colección `pnl_daily` del Mongo de Orion: UN documento por
// (trader, cuenta, día UTC) con `deals`, `lots` y `rawPnl`. La escribe un job
// propio del CRM cada 30 minutos (`pnl_daily_state.lastWindowTo`), así que el
// cierre de un día termina de asentarse DESPUÉS de medianoche — ver §Huecos.
//
// La reproducción de los tres números del panel, medida el 2026-08-31 contra
// producción, agregando `pnl_daily` de todo 2026-08:
//
//     records   8.046.498   vs   8.040.861 del panel   (+5.637)
//     volume    1.409.747,03 vs  1.408.428,98          (+1.318,05)
//     pnl        -387.954,95 vs   -388.584,65          (+629,70)
//
// Las tres diferencias van en el mismo sentido y son la deriva esperable: el
// panel se capturó horas antes y el mes seguía operando. Dos lecturas
// consecutivas nuestras dieron el MISMO número al centavo.
//
// ── LA TRAMPA DEL CENTAVO, QUE ES EL 99% DEL PROBLEMA ──────────────────────
// Sin dividir las cuentas Cent, el mismo agosto da **-63.297.145,57** en vez
// de -387.954,95: 163 veces el número real. No es un error de redondeo, es
// otra empresa. `rawPnl` viene en la moneda de la cuenta, y las Cent están en
// centavos.
//
// El factor NO se adivina del nombre del grupo: vive en
// `servergroups.centsFactor` (100 para USC, 1 para USD), y se llega a él por
// `tradingaccounts.groupId` → `servergroups.serverGroupId`. Cruzar por
// `groupName` NO sirve y ya mordió durante esta misma investigación: hay
// nombres repetidos entre servidores (`SYNTHETICS` existe en demo y en real)
// y nombres sueltos que no matchean ningún grupo (`Cent`, `Cent Investor`,
// `Cent Master`…). Con el cruce por nombre el total daba -549.801,31; por
// `groupId` da -387.954,95 y las 32.406 cuentas cruzan.
//
// Los LOTES y los CONTEOS **no se dividen**: son unidades, no dinero. Es la
// misma regla G3 del módulo de MT5, y el panel hace lo mismo (nuestro volumen
// crudo coincide con el suyo).
//
// ── QUÉ ENTRA Y QUÉ NO (verificado, no supuesto) ───────────────────────────
//   · DEMO: cero. Ningún documento de `pnl_daily` de agosto cae en un grupo
//     con `accountType: 'DEMO'`.
//   · PROPFIRM: cero. Tampoco hay un solo documento en un grupo
//     `real\PropFirm\*`. El PNL de prop firm NO está en este número (el
//     nuestro de MT5 sí lo tiene, ver la comparación en el reporte).
//   · Las familias presentes en agosto son BROKER y SOCIAL, en Cent y en USD,
//     más las Boost (`*Apalancad*`).
//
// ── EL SIGNO ───────────────────────────────────────────────────────────────
// `rawPnl` es el PNL DEL CLIENTE. Negativo = el cliente perdió = el bróker
// ganó. Se guarda con el signo del CRM, sin invertir, porque es el número que
// se compara contra el panel; quien quiera "ganancia del bróker" lo niega
// explícitamente (`brokerPnlFromClients`) en vez de que el signo cambie de
// significado a mitad de camino.
//
// ── HUECOS: null ≠ 0 ───────────────────────────────────────────────────────
// Un día sin fila es "no lo sabemos", no "cerró en cero". Por eso el cron
// reescribe una VENTANA de días y no sólo el de ayer: si una corrida falla, la
// siguiente lo tapa sola, y el `pnl_daily` de Orion también puede cambiar
// hacia atrás (`pnl_daily_purged` guarda 11.331 documentos retirados a mano
// por cuentas bloqueadas — el último lote, el 2026-08-31 a las 01:22).
// ─────────────────────────────────────────────────────────────────────────────

import { PNL_CATEGORIES, type PnlCategory } from '@/lib/mt5-sync/pnl';
import { round2 } from '@/lib/utils';

/** Un documento de `pnl_daily` de Orion, con lo único que se le lee. */
export interface CrmPnlDailyDoc {
  /** `YYYY-MM-DD` UTC. */
  day: string;
  login: string;
  deals: number;
  lots: number;
  rawPnl: number;
}

/** Lo que hace falta saber de la cuenta para interpretar su `rawPnl`. */
export interface CrmPnlAccount {
  /** `servergroups.centsFactor`: 100 = la cuenta está en centavos. */
  centsFactor: number;
  /** `servergroups.metaTraderGroupId`, p.ej. `real\Broker\Synthetics`. */
  metaTraderGroup: string | null;
}

/**
 * La categoría de la cuenta, con el MISMO registro que el módulo de MT5
 * (`PNL_CATEGORIES`) para que las dos pantallas hablen de lo mismo.
 *
 * El orden de las ramas es el de `CATEGORIA_SQL` y no es casual: las Boost
 * cuelgan de `real\Broker\…Apalancad…` y en USD, así que preguntar por la
 * moneda primero las escondería dentro de USD — exactamente donde estuvieron
 * escondidas hasta el 2026-08-26.
 *
 * Acá NO hace falta escapar barras: el grupo llega como texto de Mongo, no
 * dentro de un LIKE de SQL.
 */
export function crmPnlCategory(
  metaTraderGroup: string | null | undefined,
  centsFactor: number,
): PnlCategory {
  const g = metaTraderGroup ?? '';
  if (/\\PropFirm\\/i.test(g)) return 'PROPFIRM';
  if (/Apalancad/i.test(g)) return 'BOOST';
  if (centsFactor !== 1) return 'CENT';
  return 'USD';
}

export interface CrmDailyPnlCategoryTotals {
  category: PnlCategory;
  pnlUsd: number;
  volumeLots: number;
  dealsCount: number;
  accountsCount: number;
}

export interface CrmDailyPnlDay {
  utcDay: string;
  /** PNL del CLIENTE en USD (Cent ya dividido). Negativo = ganó el bróker. */
  pnlUsd: number;
  volumeLots: number;
  dealsCount: number;
  /** Cuentas (logins) con actividad ese día. */
  accountsCount: number;
  byCategory: CrmDailyPnlCategoryTotals[];
  /**
   * Lo EXCLUIDO del dinero, contado. Una cuenta que no está en
   * `tradingaccounts` tiene factor DESCONOCIDO: meterla con factor 1 podría
   * inflar su PNL cien veces. Sus lotes y sus deals SÍ suman (son unidades).
   */
  unmatchedAccounts: number;
  unmatchedDeals: number;
  /** El `rawPnl` crudo que quedó afuera, sin convertir. Para poder auditarlo. */
  unmatchedRawPnl: number;
}

export interface CrmDailyPnlAggregate {
  days: CrmDailyPnlDay[];
  warnings: string[];
}

const numeric = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Agrupa los documentos de `pnl_daily` por día UTC.
 *
 * Pura a propósito: es la decisión que hay que poder testear sin Mongo. Lo
 * que toca la red vive en `syncCrmDailyPnl`.
 */
export function aggregateCrmDailyPnl(
  docs: readonly CrmPnlDailyDoc[],
  accounts: ReadonlyMap<string, CrmPnlAccount>,
): CrmDailyPnlAggregate {
  const warnings: string[] = [];

  interface Acc {
    pnl: number;
    lots: number;
    deals: number;
    logins: Set<string>;
    cats: Map<PnlCategory, { pnl: number; lots: number; deals: number; logins: Set<string> }>;
    unmatched: Set<string>;
    unmatchedDeals: number;
    unmatchedRaw: number;
  }

  const porDia = new Map<string, Acc>();
  const sinCuenta = new Set<string>();

  for (const doc of docs) {
    const day = String(doc.day ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const login = String(doc.login ?? '');
    const deals = numeric(doc.deals);
    const lots = numeric(doc.lots);
    const raw = numeric(doc.rawPnl);

    const acc =
      porDia.get(day) ??
      ({
        pnl: 0,
        lots: 0,
        deals: 0,
        logins: new Set<string>(),
        cats: new Map(),
        unmatched: new Set<string>(),
        unmatchedDeals: 0,
        unmatchedRaw: 0,
      } satisfies Acc);
    porDia.set(day, acc);

    acc.logins.add(login);
    // Unidades: se suman siempre, matchee la cuenta o no (regla G3).
    acc.deals += deals;
    acc.lots += lots;

    const cuenta = accounts.get(login);
    if (!cuenta) {
      sinCuenta.add(login);
      acc.unmatched.add(login);
      acc.unmatchedDeals += deals;
      acc.unmatchedRaw += raw;
      continue;
    }

    const factor = cuenta.centsFactor > 0 ? cuenta.centsFactor : 1;
    const pnl = raw / factor;
    acc.pnl += pnl;

    const cat = crmPnlCategory(cuenta.metaTraderGroup, factor);
    const c =
      acc.cats.get(cat) ?? { pnl: 0, lots: 0, deals: 0, logins: new Set<string>() };
    c.pnl += pnl;
    c.lots += lots;
    c.deals += deals;
    c.logins.add(login);
    acc.cats.set(cat, c);
  }

  if (sinCuenta.size > 0) {
    warnings.push(
      `${sinCuenta.size} cuenta(s) del PNL diario no están en tradingaccounts: su dinero quedó FUERA del total (factor de centavos desconocido). Sus lotes y operaciones sí se cuentan.`,
    );
  }

  const days: CrmDailyPnlDay[] = [...porDia.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([utcDay, a]) => ({
      utcDay,
      pnlUsd: round2(a.pnl),
      volumeLots: round2(a.lots),
      dealsCount: a.deals,
      accountsCount: a.logins.size,
      byCategory: PNL_CATEGORIES.filter((c) => a.cats.has(c)).map((c) => {
        const v = a.cats.get(c)!;
        return {
          category: c,
          pnlUsd: round2(v.pnl),
          volumeLots: round2(v.lots),
          dealsCount: v.deals,
          accountsCount: v.logins.size,
        };
      }),
      unmatchedAccounts: a.unmatched.size,
      unmatchedDeals: a.unmatchedDeals,
      unmatchedRawPnl: round2(a.unmatchedRaw),
    }));

  return { days, warnings };
}

/**
 * La ganancia del BRÓKER a partir del PNL del cliente.
 *
 * Existe como función y no como un `-x` suelto por una razón concreta: el
 * signo de este número cambia de significado según quién lo mire, y el día
 * que alguien invierta el que se guarda, esta función es el único lugar donde
 * hay que mirar. Lo GUARDADO es siempre el del cliente, igual que el panel.
 */
export function brokerPnlFromClients(clientsPnl: number): number {
  return round2(-clientsPnl);
}

/** Los `YYYY-MM-DD` UTC entre dos fechas, inclusive. Vacío si el rango está al revés. */
export function utcDaysBetween(from: string, to: string): string[] {
  const DIA = 86_400_000;
  const desde = Date.parse(`${from}T00:00:00.000Z`);
  const hasta = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(desde) || !Number.isFinite(hasta) || desde > hasta) return [];
  const out: string[] = [];
  for (let t = desde; t <= hasta; t += DIA) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Los días del rango que NO tienen fila.
 *
 * Un hueco tiene que VERSE: si el cron falló un día, la serie no puede
 * mostrarlo en cero, porque un día en cero y un día sin dato se ven idénticos
 * y significan cosas opuestas.
 */
export function missingDays(from: string, to: string, present: readonly string[]): string[] {
  const hay = new Set(present);
  return utcDaysBetween(from, to).filter((d) => !hay.has(d));
}
