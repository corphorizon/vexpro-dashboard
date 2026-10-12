// ─────────────────────────────────────────────────────────────────────────────
// money — el ÚNICO formateador de dinero de Smart Dashboard.
//
// POR QUÉ (2026-10-12, rediseño «Libro mayor», fase 2): el mismo monto salía
// con cuatro caras según la pantalla. `formatCurrency` (utils.ts) en en-US
// —«$45,205.00»—, y al lado `toLocaleString` sueltos en es-AR, es-ES y es-CO
// —«$45.205,00»— más helpers propios por archivo (`money`, `monto`,
// `fmtCurrency`, `pdfMoney`). Medido sobre src/ antes del cambio: 56 líneas
// con `toLocaleString`; 19 llamadas (16 líneas, 9 archivos) formateaban
// dinero, más 3 helpers con su propio Intl o `$${formatNumber}`. Las otras son
// fechas, conteos, lotes y cantidades de cripto (no son USD: se quedan).
// Ejemplo: el checklist de cierre escribía «$2.373,37» (es-AR) y el resto de
// la app, vía formatCurrency, «$2,373.37». Para alguien que firma un reparto
// eso se lee como dos números distintos (o como 2,37 dólares).
//
// Y un bug concreto, repetido: `$${n.toLocaleString(…)}` con n negativo da
// «$-1,234.00». El PDF de cierre ya lo había corregido para sí mismo
// (pdfMoney); el resto no.
//
// REGLAS:
//   · Signo SIEMPRE antes del símbolo: «-$1,234.00», nunca «$-1,234.00».
//   · Se redondea a centavos con `round2` ANTES de formatear, y lo que redondea
//     a cero es «$0.00»: nunca «-$0.00» (un -0,001 de float no es una deuda).
//   · El símbolo sale de en-US (USD → «$», EUR → «€», COP → «COP »), así el
//     símbolo NO cambia cuando cambia el locale: el locale sólo decide los
//     separadores. Así `MONEY_LOCALE = 'es-AR'` da «$45.205,00» y no
//     «US$ 45.205,00», que es lo que Intl hace solo con es-AR.
//   · `signed: true` es para tablas: «+$1,234.00» / «−$1,234.00» con el signo
//     menos tipográfico (U+2212), que tiene el ancho del «+» y alinea en
//     columna. NO va por defecto porque jsPDF con Helvetica (WinAnsi) no tiene
//     ese glifo y lo imprimiría como basura: los PDF usan el formato normal.
//   · `null`/`undefined` NO se aceptan: «no lo sabemos» no es «$0.00» (§1.3 de
//     docs/reglas-del-proyecto.md). El llamador decide qué mostrar (—, «sin
//     dato»). Un NaN/Infinity llega acá sólo por bug y se muestra «—» en vez de
//     «$NaN».
//
// DESCARTADO:
//   · Formatear en el locale del usuario (es → es-AR): el dueño todavía no
//     decidió el formato (2026-10-12). Hasta entonces, en-US como hoy hace la
//     mayoría de la app. Cambiarlo es UNA línea: MONEY_LOCALE.
//   · `currencyDisplay: 'narrowSymbol'`: en es-AR deja un espacio duro entre
//     símbolo y número («$ 45.205,00») y en COP da «$», que se confunde con USD.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locale de TODO el dinero de la app (pantallas, CSV, PDF, emails, audit).
 * El dueño todavía no eligió formato: en-US es el que ya usaba formatCurrency.
 * Para pasar a «$45.205,00» basta con poner 'es-AR' acá.
 */
export const MONEY_LOCALE: string = 'en-US';

/** Signo menos tipográfico (U+2212) — sólo con `signed: true`. */
export const MINUS_SIGN = '−';

export interface FormatMoneyOptions {
  /** «+$1.00» / «−$1.00» (U+2212). Para columnas de tablas. */
  signed?: boolean;
  /** «$45.2K» / «$1.3M» — KPIs y ejes, nunca donde se concilia. */
  compact?: boolean;
  /** ISO 4217. Por defecto USD. */
  currency?: string;
  /** Sólo para tests: pisa MONEY_LOCALE. */
  locale?: string;
}

/**
 * Redondea a 2 decimales (centavos). Canónico para TODO monto que se muestra
 * o se paga — evita el drift de float al multiplicar/sumar dinero. El
 * `+ Number.EPSILON` corrige casos de coma flotante como 1.005 → 1.00.
 * (Vivía en utils.ts; se re-exporta desde ahí para no romper importadores.)
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const prefixCache = new Map<string, string>();

/** «$», «€», «COP »… tal como lo antepone en-US. */
function currencyPrefix(currency: string): string {
  const hit = prefixCache.get(currency);
  if (hit !== undefined) return hit;
  let prefix = '$';
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(1);
    const i = parts.findIndex((p) => p.type === 'currency');
    if (i >= 0) {
      prefix = parts[i].value;
      // en-US separa los códigos de letras con un espacio duro («COP 1.00»).
      const next = parts[i + 1];
      if (next && next.type === 'literal') prefix += next.value;
    }
  } catch {
    // Código de moneda inválido (dato cargado a mano): el número se muestra
    // igual con el código delante, en vez de tumbar la pantalla.
    prefix = `${currency} `;
  }
  prefixCache.set(currency, prefix);
  return prefix;
}

/**
 * EL formateador de dinero. Ver la cabecera del archivo para las reglas.
 *
 *   formatMoney(1234.5)                   → "$1,234.50"
 *   formatMoney(-1234.5)                  → "-$1,234.50"
 *   formatMoney(1234.5, { signed: true }) → "+$1,234.50"
 *   formatMoney(-12, { signed: true })    → "−$12.00"   (U+2212)
 *   formatMoney(45_205, { compact: true })→ "$45.2K"
 */
export function formatMoney(n: number, opts: FormatMoneyOptions = {}): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const { signed = false, compact = false, currency = 'USD', locale = MONEY_LOCALE } = opts;

  const v = round2(n);
  const isZero = Math.abs(v) < 0.005;
  const abs = isZero ? 0 : Math.abs(v);

  const body = compact
    ? new Intl.NumberFormat(locale, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(abs)
    : new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(abs);

  let sign = '';
  if (!isZero) {
    if (v < 0) sign = signed ? MINUS_SIGN : '-';
    else if (signed) sign = '+';
  }
  return `${sign}${currencyPrefix(currency)}${body}`;
}
