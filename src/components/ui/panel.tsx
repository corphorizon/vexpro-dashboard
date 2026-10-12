import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Panel — la superficie del sistema «Libro mayor» (spec §5.2).
//
// POR QUÉ (2026-10-12): `Card` (card.tsx) es `rounded-xl p-6 shadow-sm` y cada
// pantalla le arma su propia cabecera. Medido en src/app: 221 `<Card`, y los
// `<h2>/<h3>` de sección salen en tres tamaños (66 text-lg, 41 text-sm,
// 17 text-base); las tablas quedan dentro del p-6, que les come 24 px por
// lado. La dirección pide «pocas superficies, grandes, con bordes de 1 px»:
// una cabecera fija (48 px, h2 15/600, hint 12.5 `text-3`, acciones a
// la derecha) y un cuerpo que, si el hijo es una tabla, va al ras (`flush`).
//
// El pie (`footer`) es el lugar de la regla «un recorte se cuenta»: «Mostrando
// 21 de 1.284. Los totales usan los 1.284.» (reglas-del-proyecto.md §1.2).
//
// DESCARTADO:
//   · Margen inferior de 16 px dentro del componente (la spec lo menciona):
//     un margen propio pelea con el `gap` de las grillas que lo contienen y
//     `cn` es clsx (sin tailwind-merge), así que un `mb-0` del llamador no lo
//     pisaría de forma fiable. El espaciado lo pone el contenedor (`space-y-4`
//     / `gap-4`).
//   · Cambiar `Card`: convive hasta que cada pantalla migre (fase 5).
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  /** Línea de contexto junto al título (12.5 `text-3`). Baja de línea en < 640. */
  hint?: React.ReactNode;
  /** Botones / segmented a la derecha de la cabecera. */
  actions?: React.ReactNode;
  /** Pie 12.5 `text-3` con borde superior. Si la lista está recortada, dilo acá con números. */
  footer?: React.ReactNode;
  /** Sin padding en el cuerpo: para tablas y barras que van al ras. */
  flush?: boolean;
  /** Nivel del título. h2 por defecto (la página tiene el h1). */
  titleAs?: 'h2' | 'h3';
  bodyClassName?: string;
}

export function Panel({
  title,
  hint,
  actions,
  footer,
  flush,
  titleAs: Title = 'h2',
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const hasHeader = title != null || hint != null || actions != null;
  return (
    <section
      className={cn('rounded-ui-lg border border-border bg-card shadow-1', className)}
      {...rest}
    >
      {hasHeader && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 max-sm:flex-col">
            {title != null && (
              <Title className="text-[15px] font-semibold leading-5 tracking-[-0.005em] text-foreground">
                {title}
              </Title>
            )}
            {hint != null && <p className="text-[12.5px] leading-4 text-text-3">{hint}</p>}
          </div>
          {actions != null && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && 'p-4', bodyClassName)}>{children}</div>
      {footer != null && (
        <footer className="border-t border-border px-4 py-2.5 text-[12.5px] text-text-3">{footer}</footer>
      )}
    </section>
  );
}
