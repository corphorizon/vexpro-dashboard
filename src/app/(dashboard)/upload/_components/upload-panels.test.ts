// Piezas de presentación de /upload (migración «Libro mayor», 2026-10-12),
// renderizadas en SSR como las primitivas (src/test/render.ts): qué número
// sale en el pie, qué color lleva (y cuál ya no), qué se avisa.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { html, text } from '@/test/render';
import type { IncomeLine } from '@/lib/income-lines';
import { DepositsPanel, type DepositsPanelProps } from './deposits-panel';
import { WithdrawalsPanel, type WithdrawalsPanelProps } from './withdrawals-panel';
import { OperatingIncomePanel, type OperatingIncomePanelProps } from './operating-income-panel';
import { MovementsLedger, type MovementsLedgerProps } from './movements-ledger';
import { MovementFilters } from './movement-filters';
import { SaveBar, type SaveBarProps } from './save-bar';
import { IncomeLinesSection } from './income-lines-section';
import type { UseIncomeLinesResult } from './use-income-lines';
import { PAGE_SIZE, PaginationControls, SourceBadge } from './upload-ui';

const noop = () => {};

// ── Depósitos ────────────────────────────────────────────────────────────
function deposits(over: Partial<DepositsPanelProps> = {}) {
  const props: DepositsPanelProps = {
    rows: [
      { id: 'd1', channel: 'coinsbuy', amount: 1000 },
      { id: 'd2', channel: 'fairpay', amount: 234.5 },
    ],
    periodLabel: 'Sep 2026',
    closed: false,
    editable: true,
    savingIds: new Set(),
    onAmountChange: noop,
    onSaveRow: noop,
    propFirm: { amount: 0, crmHint: null, onChange: noop },
    ...over,
  };
  return createElement(DepositsPanel, props);
}

describe('<DepositsPanel>', () => {
  it('pie con el total de TODAS las filas, sin color (antes azul)', () => {
    const out = html(deposits());
    expect(text(deposits())).toContain('$1,234.50');
    const foot = out.slice(out.indexOf('<tfoot'));
    expect(foot).toContain('$1,234.50');
    expect(foot).not.toMatch(/text-(pos|neg|info|blue)/);
  });

  it('editable: un input por canal con la primitiva (36 px, control-border) y guardar por fila', () => {
    const out = html(deposits());
    expect(out.match(/<input/g)?.length).toBe(3); // 2 canales + ventas Prop Firm
    expect(out).toContain('border-control-border');
    expect(out).toContain('h-9');
    expect(out).toMatch(/aria-label="Guardar [^"]+"/);
  });

  it('lectura: montos con Money, sin inputs ni botón guardar', () => {
    const out = html(deposits({ editable: false }));
    expect(out).not.toContain('<input');
    expect(out).not.toContain('aria-label="Guardar');
    expect(text(deposits({ editable: false }))).toContain('$1,000.00');
  });

  it('período cerrado: badge «Cerrado» neutro e inputs deshabilitados', () => {
    const out = html(deposits({ closed: true }));
    expect(out).toContain('data-kind="neutral"');
    expect(text(deposits({ closed: true }))).toContain('Cerrado');
    expect(out.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('fila guardando: aria-busy en su botón', () => {
    expect(html(deposits({ savingIds: new Set(['d1']) }))).toContain('aria-busy="true"');
  });

  it('pista del CRM sólo si hay dato (null ≠ 0)', () => {
    expect(text(deposits())).not.toContain('El CRM tiene');
    expect(text(deposits({ propFirm: { amount: 0, crmHint: 0, onChange: noop } }))).toContain('El CRM tiene: $0.00');
  });
});

// ── Retiros ──────────────────────────────────────────────────────────────
function withdrawals(over: Partial<WithdrawalsPanelProps> = {}) {
  const props: WithdrawalsPanelProps = {
    rows: [
      { id: 'w1', category: 'ib_commissions', amount: 0 },
      { id: 'w2', category: 'broker', amount: 50 },
      { id: 'w3', category: 'prop_firm', amount: 20 },
      { id: 'w4', category: 'other', amount: 5 },
    ],
    periodLabel: 'Sep 2026',
    closed: false,
    editable: true,
    savingIds: new Set(),
    auto: { brokerIsDerived: false, derivedBrokerAmount: 0, ibEffective: { value: 0, source: 'manual' } },
    onAmountChange: noop,
    onSaveRow: noop,
    p2p: { amount: 0, crmHint: null, onChange: noop },
    extras: [],
    newExtra: { category: 'broker', amount: '', description: '' },
    setNewExtra: noop,
    onAddExtra: noop,
    onRemoveExtra: noop,
    ...over,
  };
  return createElement(WithdrawalsPanel, props);
}

describe('<WithdrawalsPanel>', () => {
  it('sin automáticos: ni badge «Auto» ni notas al pie; total sin rojo', () => {
    const out = html(withdrawals());
    expect(out).not.toContain('data-kind="info"');
    expect(text(withdrawals())).not.toContain('el campo manual de arriba convive');
    const foot = out.slice(out.indexOf('<tfoot'), out.indexOf('</tfoot>'));
    expect(foot).toContain('$75.00');
    expect(foot).not.toMatch(/text-(neg|red)/);
  });

  it('broker derivado + IB del CRM: badge «Auto» (info), montos automáticos y las dos notas', () => {
    const el = withdrawals({
      auto: { brokerIsDerived: true, derivedBrokerAmount: 820, ibEffective: { value: 180, source: 'api' } },
    });
    const out = html(el);
    const txt = text(el);
    expect(out.match(/data-kind="info"/g)?.length).toBe(2);
    expect(txt).toContain('+ API $820.00 (auto)');
    expect(txt).toContain('Del CRM: $180.00 (auto)');
    expect(txt).toContain('el campo manual de arriba convive'); // brokerCoexistNote
    // Pie = 180 (IB efectivo) + 50 + 20 + 5 + 820 — el mismo número de antes.
    expect(out.slice(out.indexOf('<tfoot'))).toContain('$1,075.00');
  });

  it('retiros adicionales: vacío con la invitación a cargar; con filas, su total', () => {
    expect(text(withdrawals())).toContain('Agrega entradas libres');
    const el = withdrawals({
      extras: [
        { id: 'x1', category: 'broker', amount: 10, description: 'Ajuste' },
        { id: 'x2', category: 'other', amount: 2.5, description: 'Otro' },
      ],
    });
    expect(text(el)).toContain('$12.50');
    expect(html(el)).toContain('aria-label="Eliminar · Ajuste"');
  });

  it('el botón Agregar de extras se habilita sólo con descripción y monto > 0', () => {
    const disabledBtn = /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*lucide-plus/;
    expect(html(withdrawals())).toMatch(disabledBtn);
    expect(html(withdrawals({ newExtra: { category: 'broker', amount: '0', description: 'x' } }))).toMatch(disabledBtn);
    expect(html(withdrawals({ newExtra: { category: 'broker', amount: '5', description: 'x' } }))).not.toMatch(disabledBtn);
  });
});

// ── Ingresos operativos ──────────────────────────────────────────────────
function income(over: Partial<OperatingIncomePanelProps> = {}) {
  const props: OperatingIncomePanelProps = {
    periodLabel: 'Sep 2026',
    closed: false,
    editable: true,
    other: { editable: true, value: 300, display: 300, fromDetail: false, onChange: noop },
    children: createElement('div', null, 'DETALLE'),
    propFirm: { show: true, sales: 100, withdrawal: 250, net: -150, onSalesChange: noop, onWithdrawalChange: noop },
    total: 150,
    onSave: noop,
    ...over,
  };
  return createElement(OperatingIncomePanel, props);
}

describe('<OperatingIncomePanel>', () => {
  it('resultado Prop Firm negativo en neg (el signo ES la noticia); total como llega', () => {
    const out = html(income());
    expect(out).toMatch(/text-neg[^>]*>-\$150\.00/);
    expect(text(income())).toContain('$150.00');
    expect(text(income())).toContain('DETALLE');
  });

  it('«Otros» derivado del detalle: se muestra lo cobrado y la nota, sin input', () => {
    const el = income({ other: { editable: false, value: 300, display: 420, fromDetail: true, onChange: noop } });
    expect(text(el)).toContain('$420.00');
    expect(html(el).match(/<input/g)?.length).toBe(2); // sólo los dos de Prop Firm
  });

  it('sin Prop Firm en el modelo: no se dibuja la sección ni su badge', () => {
    const el = income({ propFirm: { show: false, sales: 0, withdrawal: 0, net: 0, onSalesChange: noop, onWithdrawalChange: noop } });
    expect(text(el)).not.toContain('Resultado Prop Firm');
    expect(text(el)).not.toContain('pendiente Orion');
  });

  it('el botón de guardar ingresos NO es primario (uno por pantalla: «Guardar ahora»)', () => {
    expect(html(income())).not.toContain('text-brand-on-primary');
  });
});

// ── Libro de movimientos (Liquidez / Inversiones) ────────────────────────
interface Row { id: string; date: string; who: string | null; deposit: number; withdrawal: number }
type Edit = { date: string; who: string; deposit: string; withdrawal: string };

function ledger(over: Partial<MovementsLedgerProps<Row, Edit, Edit>> = {}) {
  const rows: Row[] = [
    { id: 'a', date: '2026-09-01', who: 'ana@x.com', deposit: 500, withdrawal: 0 },
    { id: 'b', date: '2026-09-02', who: null, deposit: 0, withdrawal: 200 },
  ];
  const empty: Edit = { date: '', who: '', deposit: '', withdrawal: '' };
  const props: MovementsLedgerProps<Row, Edit, Edit> = {
    title: 'Liquidez',
    caption: 'Liquidez',
    emptyText: 'Sin movimientos.',
    filters: null,
    rows,
    totalItems: rows.length,
    page: 0,
    totalPages: 1,
    onPageChange: noop,
    fields: [
      { key: 'date', header: 'Fecha', kind: 'date', read: (r) => r.date },
      { key: 'who', header: 'Concepto', kind: 'text', read: (r) => r.who },
      { key: 'deposit', header: 'Depósito', kind: 'flow', read: (r) => r.deposit },
      { key: 'withdrawal', header: 'Retiro', kind: 'flow', read: (r) => r.withdrawal },
    ],
    balanceOf: (r) => (r.id === 'a' ? 500 : 300),
    totals: { deposit: 500, withdrawal: 200, balance: 300 },
    canEdit: true,
    canDelete: true,
    canAdd: false,
    editingId: null,
    edit: empty,
    setEdit: noop,
    onStartEdit: noop,
    onSaveEdit: noop,
    onCancelEdit: noop,
    onDelete: noop,
    newFields: [],
    newValue: empty,
    setNew: noop,
    onAdd: noop,
    addDisabled: true,
    saving: false,
    ...over,
  };
  return createElement(MovementsLedger<Row, Edit, Edit>, props);
}

describe('<MovementsLedger>', () => {
  it('entradas/salidas en gris (antes verde/rojo); un 0 es «—», no «Sin dato»', () => {
    const out = html(ledger());
    expect(out).not.toMatch(/[" ]text-(pos|neg|emerald|red)/);
    expect(out).not.toContain('Sin dato');
    expect(text(ledger())).toContain('—');
  });

  it('cabeceras con nombre (antes «+» / «−»)', () => {
    const out = html(ledger());
    expect(out).toContain('Depósito');
    expect(out).toContain('Retiro');
  });

  it('pie con los totales que llegan (sobre todas las filas filtradas)', () => {
    const foot = html(ledger()).split('<tfoot')[1];
    expect(foot).toContain('$500.00');
    expect(foot).toContain('$200.00');
    expect(foot).toContain('$300.00');
  });

  it('vacío: el texto de la pantalla y sin pie', () => {
    const out = html(ledger({ rows: [], totalItems: 0 }));
    expect(out).toContain('Sin movimientos.');
    expect(out).not.toContain('<tfoot');
  });

  it('fila en edición: inputs y Guardar/Cancelar siempre visibles', () => {
    const out = html(ledger({ editingId: 'a', edit: { date: '2026-09-01', who: 'ana', deposit: '500', withdrawal: '' } }));
    expect(out.match(/<input/g)?.length).toBe(4);
    expect(out).toContain('aria-label="Guardar"');
    expect(out).toContain('aria-label="Cancelar"');
  });

  it('más de una página: el pie del panel cuenta el recorte con números', () => {
    const txt = text(ledger({ totalItems: 60, totalPages: 3 }));
    expect(txt).toContain(`1–${PAGE_SIZE} de 60`);
    expect(txt).toContain('los totales usan los 60');
  });
});

describe('<MovementFilters>', () => {
  const base = {
    dateFrom: '',
    dateTo: '',
    periodFilter: 'todos',
    sortAsc: true,
    periods: [{ id: 'p1', label: 'Sep 2026' }],
    onDateFrom: noop,
    onDateTo: noop,
    onPeriodFilter: noop,
    onToggleSort: noop,
    onClear: noop,
  };
  it('labels atados a sus controles; «Limpiar» sólo con algún filtro activo', () => {
    const out = html(createElement(MovementFilters, base));
    expect(out.match(/<label for=/g)?.length).toBe(3);
    expect(text(createElement(MovementFilters, base))).not.toContain('Limpiar');
    expect(text(createElement(MovementFilters, { ...base, periodFilter: 'p1' }))).toContain('Limpiar');
  });
});

// ── Barra de guardado ────────────────────────────────────────────────────
function saveBar(over: Partial<SaveBarProps> = {}) {
  const props: SaveBarProps = {
    periods: [
      { id: 'p1', label: 'Ago 2026', is_closed: true },
      { id: 'p2', label: 'Sep 2026', is_closed: false },
    ],
    selectedPeriod: 'p2',
    onPeriodChange: noop,
    showSave: true,
    savingAll: false,
    dirty: false,
    lastSavedAt: null,
    closed: false,
    onSave: noop,
    ...over,
  };
  return createElement(SaveBar, props);
}

describe('<SaveBar>', () => {
  it('«Guardar ahora» es EL primario: marca + text-brand-on-primary (antes emerald + blanco)', () => {
    const out = html(saveBar());
    expect(out).toContain('bg-primary text-brand-on-primary');
    expect(out).not.toMatch(/emerald|text-white/);
  });

  it('estado: sin guardar = pend, guardando = info', () => {
    expect(html(saveBar({ dirty: true }))).toContain('data-tone="pend"');
    expect(html(saveBar({ savingAll: true }))).toContain('data-tone="info"');
  });

  it('período cerrado: botón deshabilitado; el selector marca los cerrados', () => {
    expect(html(saveBar({ closed: true }))).toMatch(/<button[^>]*disabled=""/);
    expect(text(saveBar())).toContain('(Cerrado)');
  });

  it('Liquidez / Inversiones: sin botón de guardar', () => {
    expect(html(saveBar({ showSave: false }))).not.toContain('<button');
  });
});

// ── Detalle de ingresos ──────────────────────────────────────────────────
function incomeLines(lines: Partial<IncomeLine>[], over: Partial<UseIncomeLinesResult> = {}) {
  const full = lines.map((l, i) => ({
    id: `l${i}`,
    company_id: 'c',
    period_id: 'p',
    concept: `Concepto ${i}`,
    client: null,
    amount: 0,
    received: 0,
    pending: 0,
    category: null,
    reference: null,
    income_date: null,
    sort_order: i,
    ...l,
  })) as IncomeLine[];
  const form = { concept: '', client: '', amount: '', received: '', pending: '' };
  const income: UseIncomeLinesResult = {
    incomeLines: full,
    incomeTotals: {
      amount: full.reduce((s, l) => s + l.amount, 0),
      received: full.reduce((s, l) => s + l.received, 0),
      pending: full.reduce((s, l) => s + l.pending, 0),
    } as UseIncomeLinesResult['incomeTotals'],
    incomeByClient: [],
    savingIncomeLines: false,
    newIncomeLine: form,
    setNewIncomeLine: noop,
    editingIncomeLineId: null,
    setEditingIncomeLineId: noop,
    editIncomeLine: form,
    setEditIncomeLine: noop,
    addIncomeLine: noop,
    startEditIncomeLine: noop,
    saveEditIncomeLine: noop,
    markIncomeCollected: noop,
    deleteIncomeLine: noop,
    ...over,
  };
  return createElement(IncomeLinesSection, {
    income,
    userCanAdd: true,
    userCanEdit: true,
    userCanDelete: true,
    periodIsClosed: false,
  });
}

describe('<IncomeLinesSection>', () => {
  it('estado por línea con StatusBadge: cobrado = ok, pendiente = pend', () => {
    const out = html(
      incomeLines([
        { amount: 100, received: 100, pending: 0 },
        { amount: 50, received: 10, pending: 40 },
      ]),
    );
    expect(out).toContain('data-kind="ok"');
    expect(out).toContain('data-kind="pend"');
  });

  it('«marcar cobrado» sólo en las pendientes', () => {
    const out = html(
      incomeLines([
        { amount: 100, received: 100, pending: 0 },
        { amount: 50, received: 10, pending: 40 },
      ]),
    );
    expect(out.match(/aria-label="Marcar[^"]*cobrad/gi)?.length).toBe(1);
  });

  it('pie con los tres totales; franja de KPIs sin «Cobrado» en verde', () => {
    const el = incomeLines([{ amount: 100, received: 60, pending: 40 }]);
    const out = html(el);
    const foot = out.split('<tfoot')[1];
    expect(foot).toContain('$100.00');
    expect(foot).toContain('$60.00');
    expect(foot).toContain('$40.00');
    expect(out).not.toMatch(/text-(pos|positive)/);
  });

  it('vacío: sin pie', () => {
    expect(html(incomeLines([]))).not.toContain('<tfoot');
  });
});

describe('upload-ui', () => {
  it('<PaginationControls> no se dibuja con una sola página', () => {
    expect(html(createElement(PaginationControls, { page: 0, totalPages: 1, totalItems: PAGE_SIZE, onChange: noop }))).toBe('');
  });
  it('<SourceBadge>: auto = info (fuente automática), manual = neutro', () => {
    expect(html(createElement(SourceBadge, { source: 'auto' }))).toContain('data-kind="info"');
    expect(html(createElement(SourceBadge, { source: 'manual' }))).toContain('data-kind="neutral"');
  });
});

// ── Guardia: color = significado en toda la pantalla ─────────────────────
// Lo que la migración sacó no vuelve en silencio. Se ignoran los comentarios
// (las cabeceras citan las clases viejas para contar el porqué).
describe('/upload sin paleta cruda', () => {
  const dir = path.resolve(__dirname, '..');
  const files = [
    path.join(dir, 'page.tsx'),
    ...readdirSync(__dirname)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => path.join(__dirname, f)),
  ];
  const RAW =
    /\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke)-(?:red|rose|emerald|green|amber|yellow|orange|blue|sky|indigo|violet|purple|slate|gray|zinc|neutral)-\d{2,3}\b/;
  const DARK_COLOR = /\bdark:(?:hover:)?(?:text|bg|border)-/;
  const TINY = /text-\[(?:9|10|11)px\]/;
  const LEGACY = /\b(?:text|bg|border)-(?:positive|negative|warning|muted-foreground|muted)\b/;
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  for (const f of files) {
    it(path.basename(f), () => {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src).not.toMatch(RAW);
      expect(src).not.toMatch(DARK_COLOR);
      expect(src).not.toMatch(TINY);
      expect(src).not.toMatch(LEGACY);
    });
  }
});
