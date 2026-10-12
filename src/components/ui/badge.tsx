import { cn } from '@/lib/utils';

interface BadgeProps {
  variant: 'success' | 'warning' | 'danger' | 'neutral';
  children: React.ReactNode;
  className?: string;
}

/* Variantes via tokens semánticos — dark mode automático (los tokens flipan
   en .dark), un solo verde/rojo/ámbar en toda la app. */
const variants = {
  success: 'bg-pos-bg text-pos',
  warning: 'bg-pend-bg text-pend',
  danger: 'bg-neg-bg text-neg',
  neutral: 'bg-surface-2 text-text-3',
};

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}
