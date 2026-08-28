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

export function Stat({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative' | 'muted' | 'primary';
}) {
  const color = tone === 'positive' ? 'text-positive'
    : tone === 'negative' ? 'text-negative'
    : tone === 'muted' ? 'text-muted-foreground'
    : tone === 'primary' ? 'text-[var(--color-primary)]' : '';
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
