'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Piezas compartidas por las dos vistas del módulo de Liquidez: la tabla de
// cuentas y el resumen mensual.
//
// Viven acá y no dentro de una de las dos porque si el resumen importara la
// tarjeta desde la pantalla de cuentas, y la pantalla de cuentas importara el
// resumen, quedaría un ciclo. Con un archivo neutral en el medio, las dos
// importan hacia abajo y nadie hacia el costado.
// ─────────────────────────────────────────────────────────────────────────────

export const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** "Mar 26" — el año en dos dígitos para que la etiqueta entre en un chip. */
export const mesLabel = (y: number, m: number) => `${MESES[m - 1] ?? m} ${String(y).slice(2)}`;

// `Stat` (la tarjeta de cifra que vivía acá) se fue el 2026-10-12: las dos
// vistas pasaron a la franja de KPIs del sistema «Libro mayor» (`KpiStrip`).
