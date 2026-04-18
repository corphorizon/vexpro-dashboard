import { cn } from '@/lib/utils';
import { Card } from './card';

// ─────────────────────────────────────────────────────────────────────────────
// StatCard — standard KPI card used at the top of dashboard pages.
//
// Consistent spacing, icon treatment, and typography across the app. Pick
// a `tone` that matches the meaning (positive/negative/neutral/info/warning)
// and optionally pass a `hint` line for context below the value.
// ─────────────────────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'info' | 'positive' | 'negative' | 'warning' | 'primary';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  /** When true, the value is right-aligned and larger (for the hero stat). */
  emphasis?: boolean;
  className?: string;
}

const TONE_STYLES: Record<Tone, { bg: string; icon: string; value: string }> = {
  neutral: {
    bg: 'bg-slate-100 dark:bg-slate-900/50',
    icon: 'text-slate-500 dark:text-slate-400',
    value: 'text-foreground',
  },
  info: {
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    icon: 'text-blue-500 dark:text-blue-400',
    value: 'text-blue-600 dark:text-blue-400',
  },
  primary: {
    bg: 'bg-[var(--color-primary)]/10',
    icon: 'text-[var(--color-primary)]',
    value: 'text-[var(--color-primary)]',
  },
  positive: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    icon: 'text-emerald-500 dark:text-emerald-400',
    value: 'text-emerald-600 dark:text-emerald-400',
  },
  negative: {
    bg: 'bg-red-50 dark:bg-red-950/40',
    icon: 'text-red-500 dark:text-red-400',
    value: 'text-red-600 dark:text-red-400',
  },
  warning: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    icon: 'text-amber-500 dark:text-amber-400',
    value: 'text-amber-600 dark:text-amber-400',
  },
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'neutral', emphasis, className }: StatCardProps) {
  const s = TONE_STYLES[tone];
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn(
            'font-bold tabular-nums mt-1 truncate',
            emphasis ? 'text-3xl sm:text-4xl' : 'text-2xl',
            s.value,
          )}>
            {value}
          </p>
          {hint && (
            <p className="text-[11px] text-muted-foreground mt-1.5">{hint}</p>
          )}
        </div>
        {Icon && (
          <div className={cn('p-2 rounded-lg shrink-0', s.bg)}>
            <Icon className={cn('w-5 h-5', s.icon)} />
          </div>
        )}
      </div>
    </Card>
  );
}
