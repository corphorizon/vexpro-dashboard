// ─────────────────────────────────────────────────────────────────────────────
// risk-format — textos del módulo de Riesgo que no son dinero en USD, puros
// para testearlos («Libro mayor», 2026-10-12).
//
//   · `shortWallet`: «TQn9Y2…k3Xa». La dirección entera queda en el `title` y
//     en el botón de copiar (WalletAddress): acortar sin poder recuperarla
//     sería perder el dato que se vino a cotejar.
//   · `snapshotFreshness`: la foto de MT5 dice de cuándo es. El cron la
//     refresca cada ~15 min (cabecera de /risk/exposicion); con más de 30 min
//     se marca `stale` — una foto vieja en una pantalla de riesgo invita a
//     decidir sobre algo que ya no es. Una fecha inválida devuelve null: no
//     se inventa una antigüedad.
//   · `unitSuffix`: los importes de MT5 van SIEMPRE con su unidad. Las Cent
//     están en centavos y sumarlas con dólares da cientos de miles que no
//     existen (reglas §3, G3). Por eso no pasan por `formatMoney` (que pone
//     «$» y diría dólares de un número en centavos).
//
// DESCARTADO: `formatMoney(v, { currency: 'cents' })` — un código ISO
// inventado; `currencyPrefix` lo mostraría como «cents 1.00» y el texto
// variaría con el locale. El sufijo explícito es más honesto.
// ─────────────────────────────────────────────────────────────────────────────

export function shortWallet(addr: string | null | undefined, head = 6, tail = 4): string {
  const a = (addr ?? '').trim();
  if (!a) return '—';
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Minutos desde los que la foto de MT5 se marca vieja. */
export const SNAPSHOT_STALE_MIN = 30;

export interface Freshness {
  /** Minutos enteros desde la foto (0 si está en el futuro por reloj adelantado). */
  minutes: number;
  stale: boolean;
}

export function snapshotFreshness(
  at: string | number | Date | null | undefined,
  now: number,
  thresholdMin = SNAPSHOT_STALE_MIN,
): Freshness | null {
  if (at === null || at === undefined || at === '') return null;
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  return { minutes, stale: minutes > thresholdMin };
}

export type Mt5Unit = 'cents' | 'account_currency' | 'usd' | string;

/** «¢» para centavos, «USD» para el resto (lo que ya mostraban pantalla, CSV y PDF). */
export function unitSuffix(unit: Mt5Unit): string {
  return unit === 'cents' ? '¢' : 'USD';
}

/** La categoría dice la unidad: sólo CENT está denominada en centavos. */
export function unitOfCategory(category: string): 'cents' | 'account_currency' {
  return category === 'CENT' ? 'cents' : 'account_currency';
}
