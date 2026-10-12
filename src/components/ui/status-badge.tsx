import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATUS_KINDS, statusKind, type StatusKind } from './status-kind';

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge — píldora de estado del sistema «Libro mayor» (spec §5.5).
//
// POR QUÉ (2026-10-12): el `Badge` legado pinta `bg-positive/12`, un fondo
// translúcido que en oscuro cae sobre la tarjeta y da otro contraste en cada
// superficie. Los tokens `*-bg` son sólidos y están medidos (≥ 4,5:1 del texto
// encima, fijado en design-tokens.test.ts). Además el legado era sólo color:
// la spec pide el punto de 6 px antes del texto, así el estado se distingue
// también en escala de grises / daltonismo (el texto lo dice; el punto ancla).
//
// Medidas: alto 20, padding 0 7, 11.5/600, `rounded-full`, punto 6 px
// `currentColor`. `stale` cambia el punto por un reloj (el dato es viejo, no
// es un estado del flujo).
//
// El color se decide en `statusKind()` (status-kind.ts), una sola vez para
// toda la app. `<StatusBadge domain="paymentOrder" status="paid" />` evita que
// la pantalla elija el color a ojo.
//
// DESCARTADO: cambiar el `Badge` legado (sus variantes success/warning/danger
// se usan en decenas de pantallas; migran de a una, fase 5).
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_BADGE_CLASSES: Record<StatusKind, string> = {
  ok: 'text-pos bg-pos-bg',
  pend: 'text-pend bg-pend-bg',
  bad: 'text-neg bg-neg-bg',
  info: 'text-info bg-info-bg',
  stale: 'text-stale bg-stale-bg',
  neutral: 'text-text-2 bg-surface-2',
};

export { STATUS_KINDS, statusKind };
export type { StatusKind };

type StatusBadgeProps = {
  label: React.ReactNode;
  className?: string;
  title?: string;
} & (
  | { kind: StatusKind; domain?: never; status?: never }
  | { kind?: never; domain: Parameters<typeof statusKind>[0]; status: string | null | undefined }
);

export function StatusBadge(props: StatusBadgeProps) {
  const kind: StatusKind = props.kind ?? statusKind(props.domain!, props.status);
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-[7px] text-[11.5px] font-semibold leading-none',
        STATUS_BADGE_CLASSES[kind],
        props.className,
      )}
      title={props.title}
      data-kind={kind}
    >
      {kind === 'stale' ? (
        <Clock aria-hidden className="size-3 shrink-0" strokeWidth={2} />
      ) : (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      )}
      {props.label}
    </span>
  );
}
