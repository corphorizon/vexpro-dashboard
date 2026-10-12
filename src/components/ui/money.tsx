import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Money — la única forma de PINTAR un monto en pantalla («Libro mayor»).
//
// POR QUÉ (2026-10-12): `formatMoney` (src/lib/money.ts) resolvió el TEXTO,
// pero cada pantalla seguía decidiendo el resto a mano: unas con
// `tabular-nums`, otras sin (las columnas no alineaban), unas pintando de
// verde todo positivo (una columna de saldos entera en verde: el color deja de
// significar algo, §2.1 de docs/diseno-libro-mayor.md) y — el caso grave —
// `formatCurrency(x ?? 0)`, que convierte «no lo sabemos» en «$0.00»
// (docs/reglas-del-proyecto.md §1.3). Este componente fija las tres cosas:
//   · cifra: `.num` = tabular-nums + slashed-zero + nowrap (spec §3);
//   · color: `tone` — 'auto' (default) sólo pinta los negativos; 'sign' pinta
//     los dos signos (cuando el signo ES la noticia: resultado, variación);
//     'pos' / 'neg' fuerzan; 'neutral' nunca colorea;
//   · null/undefined/NaN → «—», NUNCA un 0 inventado.
//   · stale: el monto sigue mostrándose (y sumando), en `text-2` con subrayado
//     punteado `stale` (spec §5.5, «valor desactualizado»).
//
// DESCARTADO:
//   · Aceptar `null` en formatMoney: el texto de «sin dato» lo decide la UI, y
//     formatMoney también corre en PDFs/CSV donde «—» no siempre sirve.
//   · Un hook de i18n para el texto de «sin dato»: Money queda sin hooks para
//     poder usarse en server components; el llamador pasa `nullLabel`.
// ─────────────────────────────────────────────────────────────────────────────

export type MoneyTone = 'auto' | 'sign' | 'pos' | 'neg' | 'neutral';

/** Clases de cifra (spec §3). `num` queda como gancho semántico/para tests. */
export const NUM_CLASS = 'num tabular-nums slashed-zero whitespace-nowrap';

export interface MoneyProps {
  value: number | null | undefined;
  /** «+$1.00» / «−$1.00» (U+2212). Para columnas de tablas. */
  signed?: boolean;
  /** «$45.2K» — KPIs, nunca donde se concilia. El valor exacto va en `title`. */
  compact?: boolean;
  currency?: string;
  tone?: MoneyTone;
  /** true, o el texto del tooltip («Saldo de hace 26 h»). */
  stale?: boolean | string;
  /** Texto para lectores de pantalla cuando el valor es null («Sin dato»). */
  nullLabel?: string;
  className?: string;
}

/** ¿Hay un número de verdad? null, undefined, NaN e Infinity no lo son. */
export function hasValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Texto del monto: formatMoney, o «—» si no hay dato. Nunca «$0.00» por null. */
export function moneyText(
  value: number | null | undefined,
  opts: { signed?: boolean; compact?: boolean; currency?: string } = {},
): string {
  if (!hasValue(value)) return '—';
  return formatMoney(value, opts);
}

/** Clase de color según el tono. Un monto que redondea a 0 nunca se pinta. */
export function moneyToneClass(value: number | null | undefined, tone: MoneyTone = 'auto'): string | undefined {
  if (!hasValue(value)) return undefined;
  if (tone === 'pos') return 'text-pos';
  if (tone === 'neg') return 'text-neg';
  if (tone === 'neutral') return undefined;
  const cents = Math.round(value * 100);
  if (cents < 0) return 'text-neg';
  if (tone === 'sign' && cents > 0) return 'text-pos';
  return undefined;
}

export function Money({
  value,
  signed,
  compact,
  currency,
  tone = 'auto',
  stale,
  nullLabel,
  className,
}: MoneyProps) {
  if (!hasValue(value)) {
    return (
      <span className={cn(NUM_CLASS, 'text-text-3', className)} title={nullLabel}>
        <span aria-hidden={nullLabel ? true : undefined}>—</span>
        {nullLabel && <span className="sr-only">{nullLabel}</span>}
      </span>
    );
  }
  const text = moneyText(value, { signed, compact, currency });
  const exact = compact ? moneyText(value, { signed, currency }) : undefined;
  const isStale = Boolean(stale);
  return (
    <span
      className={cn(
        NUM_CLASS,
        // Un valor viejo NO lleva color de signo: el violeta punteado ya es la
        // noticia, y un verde encima afirmaría algo que no sabemos de hoy.
        isStale
          ? 'text-text-2 underline decoration-dotted decoration-stale underline-offset-[3px]'
          : moneyToneClass(value, tone),
        className,
      )}
      title={typeof stale === 'string' ? (exact ? `${exact} · ${stale}` : stale) : exact}
      data-stale={isStale || undefined}
    >
      {text}
    </span>
  );
}
