import { cn } from '@/lib/utils';

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
}

export function DataTable<T>({ columns, data, className, footerRow }: DataTableProps<T>) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col, i) => (
              <th
                key={i}
                className={cn(
                  'px-4 py-3 font-medium text-muted-foreground',
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
          {data.map((row, rowIdx) => (
            <tr key={rowIdx} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
              {columns.map((col, colIdx) => {
                const value = typeof col.accessor === 'function'
                  ? col.accessor(row)
                  : row[col.accessor] as React.ReactNode;
                return (
                  <td
                    key={colIdx}
                    className={cn(
                      'px-4 py-3',
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                      col.className
                    )}
                  >
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
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
