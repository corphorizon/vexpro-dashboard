import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// PageHeader — shared layout for the top of every dashboard page.
//
// Pattern: title + optional subtitle on the left, optional action slot on
// the right. Stacks on mobile, side-by-side on sm+ screens. Uses the
// `space-y-6` flow of the page container so consumers don't need to worry
// about bottom margin.
// ─────────────────────────────────────────────────────────────────────────────

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Optional right-side slot: buttons, selectors, badges. */
  actions?: React.ReactNode;
  /** Optional icon rendered to the left of the title. */
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, icon: Icon, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3', className)}>
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <div className="hidden sm:block p-2 rounded-lg bg-[var(--color-primary)]/10 mt-0.5">
            <Icon className="w-5 h-5 text-[var(--color-primary)]" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap">
          {actions}
        </div>
      )}
    </div>
  );
}
