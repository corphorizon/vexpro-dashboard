import { cn } from '@/lib/utils';

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-6 shadow-sm', className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-medium text-muted-foreground', className)} {...props}>
      {children}
    </h3>
  );
}

export function CardValue({ className, children, positive, negative, ...props }: React.HTMLAttributes<HTMLDivElement> & { positive?: boolean; negative?: boolean }) {
  return (
    <div
      className={cn(
        'text-2xl font-bold',
        positive && 'text-positive',
        negative && 'text-negative',
        !positive && !negative && 'text-card-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
