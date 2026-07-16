import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// DataTable — tabla de datos estándar (rediseño UX 2026-07).
//
// Specs fijas para todas las tablas financieras:
//   · Header sticky opcional (listas largas que se scrollean).
//   · Zebra sutil opcional para seguir filas en tablas densas de dinero.
//   · Densidad: 'comfortable' (default, socios no técnicos) o 'compact'.
//   · Dinero SIEMPRE align="right" (tabular-nums viene de globals.css).
//   · Scroll horizontal seguro: el wrapper trae overflow-x-auto.
// ─────────────────────────────────────────────────────────────────────────────

interface Column<T> {
  header: string;
  accessor: keyof T | ((row: T) => React.ReactNode);
  className?: string;
  align?: 'left' | 'right' | 'center';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  className?: string;
  footerRow?: React.ReactNode;
  /** Header pegado arriba al scrollear (para listas largas). */
  stickyHeader?: boolean;
  /** Rayado sutil de filas alternas — ayuda a seguir filas densas. */
  zebra?: boolean;
  density?: 'comfortable' | 'compact';
  /** Contenido a mostrar cuando data está vacío (idealmente <EmptyState compact/>). */
  empty?: React.ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  className,
  footerRow,
  stickyHeader,
  zebra,
  density = 'comfortable',
  empty,
}: DataTableProps<T>) {
  const cellPad = density === 'compact' ? 'px-3 py-2' : 'px-4 py-3';
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm">
        <thead className={cn(stickyHeader && 'sticky top-0 z-10 bg-card')}>
          <tr className="border-b border-border">
            {columns.map((col, i) => (
              <th
                key={i}
                className={cn(
                  cellPad,
                  'font-medium text-muted-foreground whitespace-nowrap',
                  col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                  col.className
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            data.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={cn(
                  'border-b border-border/50 hover:bg-muted/50 transition-colors',
                  zebra && rowIdx % 2 === 1 && 'bg-muted/30'
                )}
              >
                {columns.map((col, colIdx) => {
                  const value = typeof col.accessor === 'function'
                    ? col.accessor(row)
                    : row[col.accessor] as React.ReactNode;
                  return (
                    <td
                      key={colIdx}
                      className={cn(
                        cellPad,
                        col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                        col.className
                      )}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
        {footerRow && (
          <tfoot>
            {footerRow}
          </tfoot>
        )}
      </table>
    </div>
  );
}
