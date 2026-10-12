// /comisiones — funciones puras de presentación y render de las piezas
// extraídas con el diseño «Libro mayor» (2026-10-12). Lo que se fija acá:
// el signo de la deuda nunca se pierde (negativo = `neg`, sin clamp), «sin
// dato» nunca se muestra como $0, y ninguna pieza vuelve a la paleta cruda.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import type { CommercialProfile, Period } from '@/lib/types';
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';
import type { CommissionCalcResult } from '@/lib/commission-calculator';
import { html, text } from '@/test/render';
import {
  ROLE_LABEL,
  carriedDebtSummary,
  countSinDatoCrm,
  historyGroupKey,
  historyGroupLabel,
  isPctManual,
  ndSourceTag,
  periodLabel,
  roleLabel,
} from './commission-view';
import { DebtCell, NdSourceTag, PctOverrideInput, PnlCrmHint, personMeta } from './commission-ui';
import { TeamsTable, type InputControls, type TeamRow } from './teams-table';
import { NdIndividualTable, type NdRow } from './individual-tables';
import { HistoryTable } from './history-table';

const RAW_PALETTE = /(text|bg|border)-(red|rose|emerald|green|amber|yellow|orange|blue|sky|indigo|violet|purple)-\d{2,3}/;

function profile(p: Partial<CommercialProfile>): CommercialProfile {
  return {
    id: 'p1',
    company_id: 'c1',
    name: 'Ana García',
    email: 'ana@x.com',
    role: 'bdm',
    head_id: null,
    net_deposit_pct: 5,
    pnl_pct: null,
    commission_per_lot: null,
    salary: null,
    extra_pct: null,
    benefits: null,
    comments: null,
    hire_date: null,
    termination_date: null,
    termination_reason: null,
    termination_category: null,
    terminated_by: null,
    birthday: null,
    status: 'active',
    ...p,
  } as CommercialProfile;
}

const calc = (p: Partial<CommissionCalcResult> = {}): CommissionCalcResult => ({
  profileId: 'p1',
  netDepositCurrent: 1000,
  accumulatedIn: 0,
  division: 500,
  commissionPct: 5,
  commission: 25,
  realPayment: 25,
  accumulatedOut: 0,
  salary: 0,
  totalEarnedDebt: 0,
  ...p,
});

const controls = (source: NetDepositSource = 'crm', auto: number | null = 1000): InputControls => ({
  display: () => '',
  change: () => {},
  source: () => source,
  auto: () => auto,
});

// ── Funciones puras ─────────────────────────────────────────────────────────

describe('ndSourceTag', () => {
  it('CRM = fuente automática; manual muestra el automático; cerrado neutro; sin datos sin etiqueta', () => {
    expect(ndSourceTag('crm')).toEqual({ kind: 'api', labelKey: 'comm.ndSourceCrm', showAuto: false });
    expect(ndSourceTag('manual')).toEqual({ kind: 'manual', labelKey: 'comm.ndSourceManual', showAuto: true });
    expect(ndSourceTag('frozen')).toEqual({ kind: 'manual', labelKey: 'comm.ndSourceFrozen', showAuto: false });
    expect(ndSourceTag('none')).toEqual({ kind: 'none', labelKey: 'comm.ndSourceNone', showAuto: false });
  });
  it('sólo el override muestra el automático al lado', () => {
    const sources: NetDepositSource[] = ['crm', 'manual', 'frozen', 'none'];
    expect(sources.filter((s) => ndSourceTag(s).showAuto)).toEqual(['manual']);
  });
});

describe('isPctManual', () => {
  it('un 0 tecleado ES manual (ese mes no cobra) — §1.3', () => {
    expect(isPctManual('0')).toBe(true);
    expect(isPctManual(' 7.5 ')).toBe(true);
  });
  it('vacío o un «-» a medio teclear = automático', () => {
    expect(isPctManual('')).toBe(false);
    expect(isPctManual('   ')).toBe(false);
    expect(isPctManual('-')).toBe(false);
  });
});

describe('carriedDebtSummary', () => {
  it('cuenta y suma sólo los negativos, a centavos', () => {
    expect(carriedDebtSummary([-100.1, 0, 50, -0.254])).toEqual({ count: 2, sum: -100.35 });
  });
  it('sin deuda: 0 personas y suma 0 (no NaN)', () => {
    expect(carriedDebtSummary([])).toEqual({ count: 0, sum: 0 });
    expect(carriedDebtSummary([0, 10])).toEqual({ count: 0, sum: 0 });
  });
  it('ignora valores no finitos', () => {
    expect(carriedDebtSummary([Number.NaN, -Infinity, -5])).toEqual({ count: 1, sum: -5 });
  });
});

describe('countSinDatoCrm', () => {
  const info = new Map([
    ['a', { sinDatoCrm: true }],
    ['b', { sinDatoCrm: false }],
  ]);
  it('cuenta sólo los que el CRM marcó sin usuario', () => {
    expect(countSinDatoCrm(['a', 'b'], (id) => info.get(id))).toBe(1);
  });
  it('un perfil que no está en la respuesta NO cuenta (es «no se pidió», no «sin cruce»)', () => {
    expect(countSinDatoCrm(['z'], (id) => info.get(id))).toBe(0);
  });
});

describe('roles e historial', () => {
  it('ROLE_LABEL conserva los rótulos que leen los PDF', () => {
    expect(ROLE_LABEL).toEqual({ sales_manager: 'Sales Manager', head: 'HEAD', bdm: 'BDM', bdm_global: 'BDM GLOBAL' });
    expect(roleLabel('desconocido')).toBe('desconocido');
  });
  it('BDM GLOBAL va en el grupo BDM del Historial', () => {
    expect(historyGroupKey('sales_manager')).toBe('sales_manager');
    expect(historyGroupKey('head')).toBe('head');
    expect(historyGroupKey('bdm')).toBe('bdm');
    expect(historyGroupKey('bdm_global')).toBe('bdm');
    expect(historyGroupLabel('bdm')).toBe('BDM');
  });
  it('periodLabel: el label cargado, o AAAA-MM', () => {
    expect(periodLabel({ label: 'Agosto 2026', year: 2026, month: 8 })).toBe('Agosto 2026');
    expect(periodLabel({ label: null, year: 2026, month: 8 })).toBe('2026-08');
  });
  it('personMeta: un master se rotula como master, no como BDM', () => {
    expect(personMeta(profile({ is_master_ib: true }), 'Master IB')).toBe('Master IB · ana@x.com');
    expect(personMeta(profile({ role: 'head' }), 'Master IB')).toBe('HEAD · ana@x.com');
  });
});

// ── Render de las piezas ────────────────────────────────────────────────────

describe('<NdSourceTag>', () => {
  it('CRM en `info` (fuente automática), sin verde', () => {
    const out = html(createElement(NdSourceTag, { source: 'crm' }));
    expect(out).toContain('text-info');
    expect(out).not.toMatch(/text-pos|positive/);
  });
  it('manual NO va en ámbar: un override no requiere acción', () => {
    const out = html(createElement(NdSourceTag, { source: 'manual' }));
    expect(out).not.toMatch(/text-pend|warning/);
    expect(out).toContain('text-text-2');
  });
  it('sin datos: texto, nunca $0', () => {
    const out = text(createElement(NdSourceTag, { source: 'none' }));
    expect(out).toBe('sin datos');
    expect(out).not.toContain('$');
  });
});

describe('<PctOverrideInput>', () => {
  it('Input compacto (32 px) con borde de control y sin receta de foco propia', () => {
    const out = html(createElement(PctOverrideInput, { value: '', auto: 5, disabled: false, onChange: () => {} }));
    expect(out).toContain('h-8');
    expect(out).toContain('border-control-border');
    expect(out).toContain('placeholder="5"');
    expect(out).not.toMatch(/focus:ring|focus:outline-none/);
  });
  it('un valor manual se rotula «manual»; vacío no', () => {
    expect(text(createElement(PctOverrideInput, { value: '0', auto: 5, disabled: false, onChange: () => {} }))).toContain('manual');
    expect(text(createElement(PctOverrideInput, { value: '', auto: 5, disabled: false, onChange: () => {} }))).not.toContain('manual');
  });
  it('período cerrado: deshabilitado', () => {
    expect(html(createElement(PctOverrideInput, { value: '', auto: 5, disabled: true, onChange: () => {} }))).toContain('disabled=""');
  });
});

describe('<DebtCell> y <PnlCrmHint>', () => {
  it('deuda: monto negativo en `neg`, con signo', () => {
    const out = html(createElement(DebtCell, { prevDebt: -1500 }));
    expect(out).toContain('text-neg');
    expect(out).toContain('−$1,500.00');
  });
  it('sin deuda: «—» con texto para lector, nunca $0.00', () => {
    const out = html(createElement(DebtCell, { prevDebt: 0 }));
    expect(out).not.toContain('$0.00');
    expect(out).toContain('Sin deuda arrastrada');
  });
  it('sin usuario en el CRM: `pend` (falta un cruce)', () => {
    expect(html(createElement(PnlCrmHint, { info: { usuariosRed: null, sinDatoCrm: true } }))).toContain('text-pend');
    expect(html(createElement(PnlCrmHint, { info: undefined }))).toBe('');
  });
});

describe('<TeamsTable>', () => {
  const head = profile({ id: 'h1', name: 'Luka', role: 'head' });
  const bdm = profile({ id: 'b1', name: 'Ana', head_id: 'h1' });
  const rows: TeamRow[] = [
    { kind: 'lead', profile: head, calc: calc({ profileId: 'h1', commission: 200, realPayment: 200 }) },
    {
      kind: 'line',
      profile: bdm,
      hasOwnTeam: false,
      calc: { ...calc({ profileId: 'b1', commission: -350, realPayment: -350 }), bdmOwnPct: 3, bdmOwnPctAuto: 3, diffPct: 2, pctLinea: null },
    },
  ];
  const render = (prevDebt = 0) =>
    html(
      createElement(TeamsTable, {
        rows,
        totalCount: 2,
        nd: controls(),
        masterNd: controls(),
        pct: { display: () => '', change: () => {}, disabled: false },
        liderEsBdm: false,
        headPctAuto: 7,
        groupTotals: { lead: { commission: 200, realPayment: 200 }, line: { commission: -350, realPayment: -350 } },
        totals: { teamTotalND: 2000, totalPayment: -150, autoSalary: 1000, prevDebt, totalWithSalary: 850 + prevDebt },
      }),
    );

  it('un pago real negativo es DEUDA: `neg`, con su signo, nunca verde ni clampeado', () => {
    const out = render();
    expect(out).toContain('−$350.00');
    expect(out).toMatch(/text-neg[^"]*"[^>]*>−\$350\.00/);
    expect(out).not.toMatch(RAW_PALETTE);
  });
  it('jerarquía como filas de grupo con su subtotal real', () => {
    const tbl = render();
    expect(tbl).toContain('data-group="lead"');
    expect(tbl).toContain('data-group="line"');
    expect(tbl).toContain('Propio del líder');
    expect(tbl).toContain('Diferencial por línea');
  });
  it('pie: total del grupo, salario, deuda arrastrada y total con salario', () => {
    const out = render(-400);
    expect(out).toContain('data-foot="sub"');
    expect(out).toContain('Deuda arrastrada');
    expect(out).toContain('Total + Salario');
    expect(out).toContain('$450.00'); // 850 − 400: el mismo totalWithSalary del KPI
  });
  it('sin deuda no hay fila de deuda en el pie', () => {
    expect(render(0)).not.toContain('Deuda arrastrada');
  });
});

describe('<NdIndividualTable>', () => {
  const row: NdRow = {
    profile: profile({ id: 'b1', role: 'bdm_global' }),
    headName: undefined,
    prevDebt: -200,
    total: -50,
    calc: { ...calc({ profileId: 'b1', realPayment: 150, commission: 150 }), commissionPctAuto: 5 },
  };
  const out = html(
    createElement(NdIndividualTable, {
      rows: [row],
      totalCount: 3,
      nd: controls('manual', 900),
      pct: { display: () => '', change: () => {}, disabled: false },
      renderActions: () => null,
      footer: { nd: 1000, commission: 150, realPayment: 150, salary: 0, total: 150 },
    }),
  );
  it('total negativo en `neg`; deuda arrastrada en su columna', () => {
    expect(out).toContain('−$50.00');
    expect(out).toContain('−$200.00');
  });
  it('override visible: etiqueta manual + el automático del CRM al lado', () => {
    expect(out).toContain('manual');
    expect(out).toContain('$900.00');
  });
  it('el buscador oculta filas: lo dice con números', () => {
    expect(out).toMatch(/Mostrando 1 de 3/);
  });
  it('GLOBAL es una etiqueta neutra; head desconocido = «—»', () => {
    expect(out).toContain('GLOBAL');
    expect(out).not.toMatch(RAW_PALETTE);
  });
});

describe('<HistoryTable>', () => {
  const periods = [
    { id: 'm1', label: null, year: 2026, month: 7 },
    { id: 'm2', label: null, year: 2026, month: 8 },
  ] as Period[];
  const sm = profile({ id: 's1', role: 'sales_manager', name: 'Sol' });
  const b = profile({ id: 'b1', role: 'bdm', name: 'Ana' });
  const out = html(
    createElement(HistoryTable, {
      rows: [sm, b],
      totalCount: 2,
      periods,
      getTotal: (pid, per) => (pid === 'b1' && per === 'm1' ? null : 100),
      getProfileTotal: () => 100,
      monthTotals: { m1: 100, m2: 200 },
      grandTotal: 300,
    }),
  );
  it('sin registro = «—» (no $0); un mes sin color por ser positivo', () => {
    expect(out).toContain('Sin dato');
    expect(out).not.toContain('text-pos');
  });
  it('agrupa por rol con conteo y pie de totales por mes', () => {
    expect(out).toContain('data-group="sales_manager"');
    expect(out).toContain('data-group="bdm"');
    expect(out).toContain('2026-07');
    expect(out).toContain('$300.00');
  });
});
