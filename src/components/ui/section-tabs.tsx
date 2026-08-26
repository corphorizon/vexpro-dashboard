'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Pestañas para partir una pantalla larga en secciones.
//
// ── POR QUÉ COMPARTIDO ─────────────────────────────────────────────────────
// El mismo grupo de botones está copiado a mano en órdenes de pago, comisiones,
// usuarios, RRHH y la cola de retiros: mismas clases, mismo `aria-pressed`,
// mismo contador al lado. Cinco copias que ya divergen en detalles (una usa
// `bg-primary`, otra `bg-[var(--color-primary)]`).
//
// ── SON BOTONES, NO ENLACES ────────────────────────────────────────────────
// La sección elegida NO va a la URL. Es una preferencia de lectura de un
// momento, no un lugar: nadie comparte "la pestaña de concentración", y meterla
// en la URL agregaría una entrada al historial por cada clic, de modo que el
// botón Atrás dejaría de significar "la pantalla anterior".
//
// ── ACCESIBILIDAD ──────────────────────────────────────────────────────────
// Se usa `aria-pressed` y no `role="tablist"` a propósito: el patrón ARIA de
// pestañas obliga a manejar flechas del teclado y `aria-controls` sobre paneles
// con id, y sin eso un lector de pantalla anuncia "pestaña" y promete una
// navegación que no existe. Un grupo de botones de alternar cumple lo que
// promete.
// ─────────────────────────────────────────────────────────────────────────────

import { cn } from '@/lib/utils';

export interface SectionTab<T extends string> {
  value: T;
  label: string;
  /** Contador opcional al lado del nombre. `null` = no se muestra. */
  count?: number | null;
  /** Marca la sección como preocupante (por ejemplo, cuentas en riesgo). */
  tone?: 'default' | 'negative' | 'warning';
}

export function SectionTabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: SectionTab<T>[];
  /** Nombre del grupo para lectores de pantalla. */
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const activa = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            aria-pressed={activa}
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
              activa
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                : 'border-border hover:bg-muted',
            )}
          >
            {tab.label}
            {tab.count !== null && tab.count !== undefined && (
              <span
                className={cn(
                  'ml-1.5 tabular-nums',
                  activa
                    ? 'opacity-70'
                    : tab.tone === 'negative'
                      ? 'text-negative'
                      : tab.tone === 'warning'
                        ? 'text-warning'
                        : 'opacity-70',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
