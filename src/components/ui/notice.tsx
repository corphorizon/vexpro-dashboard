import { AlertTriangle, Clock, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Notice — banner de ESTADO DEL DATO («Libro mayor», spec §5.5).
//
// POR QUÉ (2026-10-12): los avisos de «faltan datos / dato viejo» se armaban a
// mano en cada pantalla, y 20 de ellos nacieron rotos: dos opacidades
// encadenadas (`bg-warning/10` seguido de `/30`) que Tailwind descarta sin
// avisar, así que el aviso quedaba SIN fondo — un banner que no se ve es un
// recorte silencioso (fase 0, ver design-tokens.test.ts). Al lado,
// `text-red-700 dark:text-red-300`: paleta cruda que no flipa con la marca.
// Acá hay UNA receta: fondo `*-bg` (sólido, medido), borde del color al 35 %,
// texto `foreground`, ícono 16 del color.
//
// La spec pide que el banner diga SIEMPRE la cifra afectada y ofrezca
// «Revisar»: por eso `title` + `children` (el detalle con el número) +
// `action` (el enlace). El componente no puede verificar que haya cifra; el
// ejemplo de la muestra (/_design) y la doc lo dejan explícito.
//
// Rol ARIA: `bad` es `alert` (algo falló y hay que enterarse ya); el resto es
// `status` (se anuncia sin interrumpir).
//
// DESCARTADO: variante `ok` — «todo bien» no necesita banner; el punto de
// frescura de la topbar ya lo dice (spec §6.2).
// ─────────────────────────────────────────────────────────────────────────────

export type NoticeKind = 'stale' | 'pend' | 'info' | 'bad';

const STYLES: Record<NoticeKind, { box: string; icon: string; Icon: typeof Info }> = {
  stale: { box: 'bg-stale-bg border-stale/35', icon: 'text-stale', Icon: Clock },
  pend: { box: 'bg-pend-bg border-pend/35', icon: 'text-pend', Icon: AlertTriangle },
  info: { box: 'bg-info-bg border-info/35', icon: 'text-info', Icon: Info },
  bad: { box: 'bg-neg-bg border-neg/35', icon: 'text-neg', Icon: XCircle },
};

export interface NoticeProps {
  kind: NoticeKind;
  title: React.ReactNode;
  /** Detalle, con la cifra afectada («siguen sumando $60,180.12»). */
  children?: React.ReactNode;
  /** Enlace / botón «Revisar». */
  action?: React.ReactNode;
  className?: string;
}

export function Notice({ kind, title, children, action, className }: NoticeProps) {
  const s = STYLES[kind];
  const Icon = s.Icon;
  return (
    <div
      role={kind === 'bad' ? 'alert' : 'status'}
      data-kind={kind}
      className={cn(
        'flex items-start gap-2.5 rounded-ui-md border px-3.5 py-2.5 text-[13px] leading-5 text-foreground',
        s.box,
        className,
      )}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', s.icon)} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children != null && <div className="text-text-2">{children}</div>}
      </div>
      {action != null && <div className="shrink-0 self-center font-medium">{action}</div>}
    </div>
  );
}
