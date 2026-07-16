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
  /**
   * Label shown above the value. Accepts any ReactNode so callers can inline
   * tooltips / badges / info icons next to the text.
   */
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  /** When true, the value is right-aligned and larger (for the hero stat). */
  emphasis?: boolean;
  className?: string;
}

/* Tonos cableados a los tokens semánticos de globals.css — flipan solos en
   dark mode (nada de variantes dark: a mano). El valor neutral queda en tinta
   normal; solo los tonos con significado colorean la cifra. */
const TONE_STYLES: Record<Tone, { bg: string; icon: string; value: string }> = {
  neutral: {
    bg: 'bg-muted',
    icon: 'text-muted-foreground',
    value: 'text-foreground',
  },
  info: {
    bg: 'bg-info/10',
    icon: 'text-info',
    value: 'text-info',
  },
  primary: {
    bg: 'bg-primary/10',
    icon: 'text-primary dark:text-accent',
    value: 'text-primary dark:text-accent',
  },
  positive: {
    bg: 'bg-positive/10',
    icon: 'text-positive',
    value: 'text-positive',
  },
  negative: {
    bg: 'bg-negative/10',
    icon: 'text-negative',
    value: 'text-negative',
  },
  warning: {
    bg: 'bg-warning/10',
    icon: 'text-warning',
    value: 'text-warning',
  },
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'neutral', emphasis, className }: StatCardProps) {
  const s = TONE_STYLES[tone];
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">{label}</div>
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
