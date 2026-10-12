import { clsx, type ClassValue } from 'clsx';
import { formatMoney } from './money';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// round2 vive ahora en money.ts (junto con el formateador de dinero); se
// re-exporta acá para no romper a quienes la importan de '@/lib/utils'.
export { round2 } from './money';

/**
 * Dinero con símbolo. DELEGA en `formatMoney` (src/lib/money.ts), el único
 * formateador de dinero: misma salida que antes en en-US («$1,234.50»,
 * «-$1,234.50»), salvo que un -0,001 ya no sale «-$0.00» y un NaN sale «—»
 * en vez de «$NaN». Se mantiene la firma para no tocar a sus ~50 archivos llamadores.
 */
export function formatCurrency(value: number, currency = 'USD'): string {
  return formatMoney(value, { currency });
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Fracción (0.5) → "50.0%". Para valores YA en porcentaje (50 → "50.0%")
 *  usar `formatPercentValue` — no multiplica por 100. */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Valor YA en porcentaje (50) → "50.0%". No multiplica por 100.
 *  (formatPercent toma fracción y sí multiplica — footgun señalado en ARQ-01). */
export function formatPercentValue(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function periodLabel(year: number, month: number): string {
  const months = [
    '', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
    'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
  ];
  return `${months[month]} ${year.toString().slice(-2)}`;
}
