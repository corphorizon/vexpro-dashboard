import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// PageHeader — la cabecera de cada pantalla del dashboard.
//
// «Libro mayor» (docs/diseno-libro-mayor.md §3 y §6.3, Fase 4 2026-10-12):
//   · h1 22/28 (20 en < 640), peso 650, tracking −0.015em.
//   · Bajada 13.5 `text-text-2`.
//   · Acciones a la derecha, alineadas ABAJO (con la bajada, no con el
//     título) y envolviendo. **Un solo botón primario por vista**: si hay
//     dos acciones principales, una de ellas no lo es.
//
// La API NO cambió (title, subtitle, actions, icon, className): la usan ~50
// pantallas y cada una se migra en su propio cambio (fase 5). Antes era
// `text-2xl font-bold` (24/700) con el ícono en `bg-[var(--color-primary)]/10`
// + `text-primary dark:text-accent`; ahora sólo tokens (`brand-tint` /
// `brand-ink`, que flipan solos con el tema).
//
// Descartado: sacar el `icon` (la spec no lo dibuja). Lo pasan varias
// pantallas; quitarlo es un cambio de API que no le toca a la shell.
// ─────────────────────────────────────────────────────────────────────────────

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Slot derecho: botones, selectores, badges. Un solo primario. */
  actions?: React.ReactNode;
  /** Ícono opcional a la izquierda del título. */
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, icon: Icon, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <div className="mt-0.5 hidden rounded-ui-md bg-brand-tint p-1.5 text-brand-ink sm:block" aria-hidden="true">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 text-[13.5px] text-text-2">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}
