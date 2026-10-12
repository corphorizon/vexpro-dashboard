import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// SourceTag — etiqueta de FUENTE de un número («API», «Manual»), spec §5.5
// `.src` del diseño «Libro mayor».
//
// POR QUÉ (2026-10-12): Movimientos rotulaba la fuente con texto de 10 px
// en mayúsculas y un color por fuente (esmeralda crudo para «api», gris para
// «manual»). El verde decía «bueno» sobre algo que sólo es una procedencia —
// color sin significado (spec §2.1) — y 10 px queda por debajo del mínimo de
// 11.5 px de la tanda. Acá: borde + texto; API en `info` (fuente automática,
// que es lo que `info` significa en la tabla de tokens), manual en gris.
//
// DESCARTADO: los 10.5 px de la spec §5.5 — la tanda fija 11.5 como piso.
// Moverla a src/components/ui: hoy sólo la usa /movimientos; se
// promueve cuando una segunda pantalla la necesite (Balances la dibuja con
// sus propias filas en este momento, otro cambio).
// ─────────────────────────────────────────────────────────────────────────────

export type SourceKind = 'api' | 'manual' | 'api+manual';

export function SourceTag({ kind, label, className }: { kind: SourceKind; label: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-ui-sm border px-1.5 align-middle',
        'text-[11.5px] font-semibold uppercase leading-none tracking-[.03em]',
        kind === 'manual' ? 'border-border-strong text-text-2' : 'border-info/35 bg-info-bg text-info',
        className,
      )}
    >
      {label}
    </span>
  );
}
