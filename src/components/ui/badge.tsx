import { cn } from '@/lib/utils';

interface BadgeProps {
  variant: 'success' | 'warning' | 'danger' | 'neutral';
  children: React.ReactNode;
  className?: string;
}

/* Variantes via tokens semánticos — dark mode automático (los tokens flipan
   en .dark), un solo verde/rojo/ámbar en toda la app. */
const variants = {
  success: 'bg-positive/12 text-positive',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-negative/12 text-negative',
  neutral: 'bg-muted text-muted-foreground',
};

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}
