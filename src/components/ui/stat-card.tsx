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
    bg: 'bg-surface-2',
    icon: 'text-text-3',
    value: 'text-foreground',
  },
  info: {
    bg: 'bg-info-bg',
    icon: 'text-info',
    value: 'text-info',
  },
  primary: {
    bg: 'bg-brand-tint',
    icon: 'text-brand-ink',
    value: 'text-brand-ink',
  },
  positive: {
    bg: 'bg-pos-bg',
    icon: 'text-pos',
    value: 'text-pos',
  },
  negative: {
    bg: 'bg-neg-bg',
    icon: 'text-neg',
    value: 'text-neg',
  },
  warning: {
    bg: 'bg-pend-bg',
    icon: 'text-pend',
    value: 'text-pend',
  },
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'neutral', emphasis, className }: StatCardProps) {
  const s = TONE_STYLES[tone];
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wide text-text-3 flex items-center gap-1.5">{label}</div>
          {/* `truncate` evita que un número largo rompa la grilla, pero a
              text-4xl un saldo de seis cifras se cortaba ("$10,87…"). El
              tamaño de énfasis baja un escalón y crece recién en pantallas
              anchas; el title deja ver el valor completo al pasar el mouse. */}
          <p
            title={typeof value === 'string' ? value : undefined}
            className={cn(
              'font-bold tabular-nums mt-1 truncate',
              emphasis ? 'text-2xl sm:text-3xl' : 'text-2xl',
              s.value,
            )}
          >
            {value}
          </p>
          {hint && (
            <p className="text-xs text-text-3 mt-1.5">{hint}</p>
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
