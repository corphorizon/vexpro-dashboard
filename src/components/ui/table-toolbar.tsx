'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Buscador y paginado de tabla, en UN solo lugar.
//
// ── POR QUÉ COMPARTIDO Y NO UNA COPIA POR PANTALLA ─────────────────────────
// Porque ya empezó a pasar: `retiros-propfirm` tenía su propio `PAGE_SIZE = 50`
// suelto. Dos copias del mismo número no se contradicen el día que se escriben,
// se contradicen tres meses después cuando alguien cambia una. Y el síntoma no
// es un error: es que una tabla pagina de a 50 y otra de a 25, y nadie lo nota.
//
// ── EL PAGINADO VUELVE A LA PÁGINA 1 AL FILTRAR ────────────────────────────
// Si no lo hiciera, buscar algo estando en la página 4 mostraría una tabla
// vacía —porque el resultado filtrado tiene una sola página— y eso se lee como
// "no hay resultados" cuando en realidad los hay.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Filas por página. Es EL número: cualquier tabla del dashboard que pagine
 * usa este hook y por lo tanto este valor.
 */
export const TABLE_PAGE_SIZE = 50;

export interface TablePage<T> {
  query: string;
  setQuery: (v: string) => void;
  page: number;
  setPage: (n: number) => void;
  /** Las filas de la página actual: lo que se le pasa a la tabla. */
  pageRows: T[];
  /** Filas que pasaron el filtro, de todas las páginas. */
  filtered: T[];
  pageCount: number;
  total: number;
}

/**
 * Filtra y pagina en memoria.
 *
 * En memoria a propósito: estas tablas ya vienen enteras en la foto que la
 * pantalla cargó (cientos de filas, no cientos de miles). Ir al servidor por
 * cada tecla sería un viaje por dato que ya está en el navegador.
 *
 * `searchable` devuelve el texto contra el que se busca. Se le pide a quien
 * llama en vez de recorrer el objeto entero porque buscar sobre todos los
 * campos hace que un número de una columna interna produzca coincidencias que
 * nadie se explica.
 */
export function useTablePage<T>(
  rows: T[],
  searchable: (row: T) => string,
  pageSize: number = TABLE_PAGE_SIZE,
): TablePage<T> {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchable(r).toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));

  // Volver al principio cuando cambia el filtro, y no quedarse en una página
  // que ya no existe cuando los datos se achican (por ejemplo al refrescar).
  useEffect(() => {
    setPage(0);
  }, [query]);
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const pageRows = useMemo(
    () => filtered.slice(page * pageSize, (page + 1) * pageSize),
    [filtered, page, pageSize],
  );

  return { query, setQuery, page, setPage, pageRows, filtered, pageCount, total: rows.length };
}

export function TableSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        // `text-base` en móvil a propósito: por debajo de 16px iOS hace zoom
        // forzado al enfocar el campo y descoloca la pantalla entera.
        className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-base sm:text-sm"
      />
    </div>
  );
}

/**
 * Pie de tabla. No se oculta cuando hay una sola página: decir "1–37 de 37" es
 * lo que confirma que no falta nada. Una tabla sin pie deja la duda de si está
 * cortada.
 */
export function TablePager({
  page,
  pageCount,
  shown,
  total,
  filteredTotal,
  onPage,
  labels,
}: {
  page: number;
  pageCount: number;
  shown: number;
  total: number;
  filteredTotal: number;
  onPage: (n: number) => void;
  labels: { prev: string; next: string; range: string; filtered: string };
}) {
  const desde = filteredTotal === 0 ? 0 : page * TABLE_PAGE_SIZE + 1;
  const hasta = page * TABLE_PAGE_SIZE + shown;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {labels.range
          .replace('{from}', String(desde))
          .replace('{to}', String(hasta))
          .replace('{total}', String(filteredTotal))}
        {filteredTotal !== total && (
          <span className="ml-1">{labels.filtered.replace('{total}', String(total))}</span>
        )}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
          aria-label={labels.prev}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span className="tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
          aria-label={labels.next}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
