// FinTable: subtotales que no inventan, recorte contado, tarjeta móvil.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { FinTable, hasNodeContent, type FinColumn } from './fin-table';
import { cardLayout, groupRows, isTruncated, subtotal } from './fin-table-model';
import { html, text } from '@/test/render';

interface Row {
  id: string;
  name: string;
  group: string;
  amount: number | null;
}

const ROWS: Row[] = [
  { id: '1', name: 'Coinsbuy', group: 'gw', amount: 100 },
  { id: '2', name: 'FairPay', group: 'gw', amount: null },
  { id: '3', name: 'Binance', group: 'ex', amount: 50.5 },
  { id: '4', name: 'Pay-Pros', group: 'gw', amount: 20.25 },
];

const COLS: FinColumn<Row>[] = [
  { key: 'name', header: 'Canal', cell: (r) => r.name, meta: () => 'API' },
  { key: 'group', header: 'Grupo', cell: (r) => r.group, hideSm: true },
  { key: 'amount', header: 'Saldo', kind: 'money', value: (r) => r.amount },
];

describe('subtotal / groupRows', () => {
  it('null no es 0: se cuenta aparte', () => {
    expect(subtotal(ROWS, (r) => r.amount)).toEqual({ sum: 170.75, missing: 1, partial: false });
  });
  it('todo null → sum null (nunca $0.00)', () => {
    expect(subtotal([{ v: null }, { v: undefined }], (r) => r.v).sum).toBeNull();
  });
  it('lista recortada → subtotal parcial = null', () => {
    const s = subtotal(ROWS, (r) => r.amount, true);
    expect(s.sum).toBeNull();
    expect(s.partial).toBe(true);
  });
  it('agrupa en orden de aparición, con conteo de filas sin dato', () => {
    const g = groupRows(ROWS, (r) => r.group, [{ key: 'amount', value: (r) => r.amount }]);
    expect(g.map((x) => x.key)).toEqual(['gw', 'ex']);
    expect(g[0].rows).toHaveLength(3);
    expect(g[0].subtotals.amount.sum).toBe(120.25);
    expect(g[0].missingRows).toBe(1);
    expect(g[1].missingRows).toBe(0);
  });
});

describe('isTruncated', () => {
  it('sólo si el total conocido supera lo mostrado', () => {
    expect(isTruncated(21, 1284)).toBe(true);
    expect(isTruncated(21, 21)).toBe(false);
    expect(isTruncated(21, null)).toBe(false);
    expect(isTruncated(21, undefined)).toBe(false);
    expect(isTruncated(21, NaN)).toBe(false);
  });
});

describe('cardLayout', () => {
  it('texto a la izquierda, dinero/números a la derecha, hideSm fuera; filas explícitas', () => {
    expect(
      cardLayout([
        { key: 'name' },
        { key: 'status', cardSide: 'right' },
        { key: 'when', hideSm: true },
        { key: 'amount', kind: 'money' },
        { key: 'note' },
      ]),
    ).toEqual({
      name: { side: 'left', row: 1 },
      status: { side: 'right', row: 1 },
      when: { side: 'hidden', row: 0 },
      amount: { side: 'right', row: 2 },
      note: { side: 'left', row: 2 },
    });
  });
});

describe('<FinTable>', () => {
  it('cabecera sticky en mayúsculas 11.5 px; dinero a la derecha con <Money>', () => {
    const out = html(createElement(FinTable<Row>, { columns: COLS, rows: ROWS, rowKey: (r) => r.id }));
    expect(out).toContain('sticky top-0');
    expect(out).toContain('uppercase tracking-[.03em]');
    expect(out).toContain('text-[11.5px]');
    expect(out).toContain('$100.00');
    expect(out).toMatch(/<td[^>]*text-right[^>]*><span[^>]*num tabular-nums/);
    expect(out).toContain('min-[720px]:h-row');
  });

  it('el null de una celda es «—» con «Sin dato» para lectores, no $0.00', () => {
    const out = text(createElement(FinTable<Row>, { columns: COLS, rows: [ROWS[1]], rowKey: (r) => r.id }));
    expect(out).toContain('—');
    expect(out).toContain('Sin dato');
    expect(out).not.toContain('$0.00');
  });

  it('grupos con conteo, «N sin dato» y subtotal', () => {
    const out = text(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        groupBy: (r) => r.group,
        groupLabel: (k) => (k === 'gw' ? 'Pasarelas' : 'Exchanges'),
      }),
    );
    expect(out).toContain('Pasarelas · 3 · 1 sin dato');
    expect(out).toContain('$120.25');
    expect(out).toContain('Exchanges · 1');
  });

  it('recortada: lo dice con números y NO muestra subtotales de lo visible', () => {
    const out = text(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        groupBy: (r) => r.group,
        totalCount: 1284,
      }),
    );
    expect(out).toContain('Mostrando 4 de 1,284 · los totales usan los 1,284');
    expect(out).not.toContain('$120.25');
    expect(out).toContain('Subtotal parcial');
  });

  it('pie de total con la doble raya, el valor del llamador y la etiqueta que dice lo excluido', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        footer: { label: 'Total (3 de 4 canales)', values: { amount: 999.99 } },
      }),
    );
    expect(out).toContain('<tfoot');
    expect(out).toContain('shadow-[inset_0_1.5px_0_0_var(--foreground)]');
    expect(out).toContain('Total (3 de 4 canales)');
    expect(out).toContain('$999.99');
  });

  it('filas de pie previas al total (subtotal, comisiones): sin doble raya, el total la lleva una sola vez y va último', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        footerRows: [
          { label: 'Subtotal', values: { amount: 170.75 } },
          { label: 'Comisiones', values: { amount: 4.25 } },
        ],
        footer: { label: 'Total a pagar', values: { amount: 175 } },
      }),
    );
    const foot = out.slice(out.indexOf('<tfoot'), out.indexOf('</tfoot>'));
    expect(foot.match(/data-foot="sub"/g)).toHaveLength(2);
    expect(foot.match(/data-foot="total"/g)).toHaveLength(1);
    expect(foot.match(/inset_0_1\.5px_0_0_var\(--foreground\)/g)).toHaveLength(COLS.length);
    expect(foot.indexOf('Subtotal')).toBeLessThan(foot.indexOf('Comisiones'));
    expect(foot.indexOf('Comisiones')).toBeLessThan(foot.indexOf('Total a pagar'));
    expect(foot).toContain('$170.75');
    expect(foot).toContain('$4.25');
    expect(foot).toContain('$175.00');
  });

  it('tarjeta < 720 px: thead oculto, fila grid de 2 columnas, hideSm oculto', () => {
    const out = html(createElement(FinTable<Row>, { columns: COLS, rows: ROWS, rowKey: (r) => r.id }));
    expect(out).toContain('<thead class="max-[720px]:hidden"');
    expect(out).toContain('max-[720px]:grid-cols-[minmax(0,1fr)_auto]');
    expect(out).toContain('grid-column:2;grid-row:1');
    expect(out).toMatch(/<td[^>]*max-\[720px\]:hidden[^>]*>gw<\/td>/);
  });

  it('fila seleccionada: tinte + barra izquierda; clicable por teclado', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        selectedKey: '3',
        onRowClick: () => {},
      }),
    );
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toContain('bg-row-selected');
    expect(out).toContain('inset_3px_0_0_0_var(--brand-ink)');
    expect(out.match(/tabindex="0"/g)).toHaveLength(ROWS.length);
  });

  it('acciones de fila: ocultas hasta hover/foco en escritorio, con cabecera para lectores', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        rowActions: (r) => createElement('button', { 'aria-label': `Acciones de ${r.name}` }, '…'),
      }),
    );
    expect(out).toContain('min-[720px]:opacity-0 min-[720px]:group-hover/row:opacity-100');
    expect(out).toContain('group-focus-within/row:opacity-100');
    expect(out).toContain('<span class="sr-only">Acciones</span>');
  });

  it('acciones en tarjeta: misma fila que el monto (3.ª columna), y sin celda si la fila no tiene', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        rowActions: (r) => (r.id === '2' ? null : createElement('button', { 'aria-label': `Ver ${r.name}` }, '·')),
      }),
    );
    expect(out).toContain('max-[720px]:grid-cols-[minmax(0,1fr)_auto_auto]');
    // Fila 1, columna 3: al lado del monto (que es columna 2, fila 1).
    expect(out.match(/grid-column:3;grid-row:1/g)).toHaveLength(ROWS.length);
    // FairPay no tiene acciones: su celda no ocupa lugar en la tarjeta.
    expect(out.match(/w-px whitespace-nowrap text-right max-\[720px\]:hidden/g)).toHaveLength(1);
    // Sin rowActions la tarjeta sigue en 2 columnas.
    expect(html(createElement(FinTable<Row>, { columns: COLS, rows: ROWS, rowKey: (r) => r.id }))).not.toContain(
      '_auto_auto',
    );
  });

  it('hasNodeContent: null/false/vacío no son acciones', () => {
    expect(hasNodeContent(null)).toBe(false);
    expect(hasNodeContent(false)).toBe(false);
    expect(hasNodeContent('')).toBe(false);
    expect(hasNodeContent([null, false])).toBe(false);
    expect(hasNodeContent([null, createElement('a')])).toBe(true);
  });

  it('vacía: mensaje, no una tabla muda', () => {
    expect(text(createElement(FinTable<Row>, { columns: COLS, rows: [], rowKey: (r) => r.id }))).toContain(
      'No hay nada para mostrar',
    );
  });

  it('rowVariant «total»: fila group-row en 600, sin hover; las demás quedan igual', () => {
    const out = html(
      createElement(FinTable<Row>, {
        columns: COLS,
        rows: ROWS,
        rowKey: (r) => r.id,
        rowVariant: (r) => (r.id === ROWS[0].id ? 'total' : undefined),
      }),
    );
    const trs = out.match(/<tr[^>]*>/g) ?? [];
    const total = trs.filter((tr) => tr.includes('data-variant="total"'));
    expect(total).toHaveLength(1);
    expect(total[0]).toContain('bg-group-row font-semibold');
    expect(total[0]).not.toContain('hover:bg-row-hover');
    expect(trs.filter((tr) => tr.includes('hover:bg-row-hover')).length).toBe(ROWS.length - 1);
  });
});
