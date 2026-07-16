import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton — placeholder de carga unificado (rediseño UX 2026-07).
// Antes cada página hacía el suyo con divs + animate-pulse; esta primitiva
// fija superficie y ritmo. Composición típica:
//
//   <div className="space-y-6">
//     <Skeleton className="h-8 w-56" />
//     <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
//       {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
//     </div>
//   </div>
// ─────────────────────────────────────────────────────────────────────────────

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-xl bg-muted/70', className)}
      {...props}
    />
  );
}

/** Fila de skeleton para tablas: n celdas de ancho variable. */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className={cn('h-4 rounded', i === 0 ? 'w-32' : 'w-16 ml-auto')} />
        </td>
      ))}
    </tr>
  );
}
