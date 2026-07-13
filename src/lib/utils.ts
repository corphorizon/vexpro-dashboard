import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Redondea a 2 decimales (centavos). Canónico para TODO monto que se muestra
 * o se paga — evita el drift de float al multiplicar/sumar dinero. El
 * `+ Number.EPSILON` corrige casos de coma flotante como 1.005 → 1.00.
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
