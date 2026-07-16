import { cn } from '@/lib/utils';
import { Inbox } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// EmptyState — estado vacío diseñado (rediseño UX 2026-07).
// Antes: texto gris plano ("No hay configuraciones"). Ahora: icono en chip +
// título + descripción opcional + CTA opcional que guía al siguiente paso.
//
//   <EmptyState
//     icon={Receipt}
//     title="Sin egresos este mes"
//     description="Cargá los gastos del período para ver el desglose."
//     action={<Button variant="primary" onClick={…}>Cargar egresos</Button>}
//   />
// ─────────────────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** compact: para celdas de tabla / paneles chicos. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-6 px-4' : 'py-12 px-6',
        className,
      )}
    >
      <div className={cn('rounded-full bg-muted flex items-center justify-center', compact ? 'w-9 h-9 mb-2.5' : 'w-12 h-12 mb-3')}>
        <Icon className={cn('text-muted-foreground', compact ? 'w-4.5 h-4.5' : 'w-6 h-6')} />
      </div>
      <p className={cn('font-medium text-foreground', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && (
        <p className={cn('text-muted-foreground mt-1 max-w-sm', compact ? 'text-xs' : 'text-sm')}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
