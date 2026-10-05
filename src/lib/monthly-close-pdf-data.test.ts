import { describe, it, expect } from 'vitest';
import {
  pdfMoney,
  longPeriodLabel,
  generatedOnLabel,
  buildCloseWaterfall,
  buildCloseExpenses,
  buildClientFlow,
  buildCrmInfoRows,
  incomeSourcesLabel,
  type WaterfallInput,
  type ClientFlowInput,
} from './monthly-close-pdf-data';
import { API_DEPOSIT_CHANNELS } from './deposit-channels';
import { API_WITHDRAWAL_CHANNELS } from './withdrawal-channels';
import { CRM_MONTHLY_OUTSIDE_RESULT_METRICS, CRM_MONTHLY_METRICS } from './crm-monthly';
import { computeDistributionChain } from './distribution';
import type { ProviderDataset } from './api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// Números REALES de Vex Pro, septiembre 2026 (Kevin, 2026-10-05). Con esto el
// PDF imprimía Broker P&L y Prop Firm en $0,00 junto a unos Ingresos Netos de
// 263.469,99: los sumandos salían de tablas manuales vacías.
// ─────────────────────────────────────────────────────────────────────────────
const SEP26 = {
  brokerPnl: 226_605.2,
  propFirmNetIncome: 13_248.27,
  investmentProfits: 23_616.52,
  other: 0,
};
const SEP26_INGRESOS = 263_469.99;

describe('pdfMoney', () => {
  it('positivo: $ y separadores de la app', () => {
    expect(pdfMoney(226_605.2)).toBe('$226,605.20');
  });

  it('negativo: el signo va ANTES del símbolo (era «$-208,084.45»)', () => {
    expect(pdfMoney(-208_084.45)).toBe('-$208,084.45');
    expect(pdfMoney(-208_084.45)).not.toContain('$-');
  });

  it('cero y casi-cero nunca salen «-$0.00»', () => {
    expect(pdfMoney(0)).toBe('$0.00');
    expect(pdfMoney(-0)).toBe('$0.00');
    expect(pdfMoney(-0.001)).toBe('$0.00');
  });

  it('redondea a centavos', () => {
    expect(pdfMoney(-10.005)).toBe('-$10.01');
    expect(pdfMoney(1.234)).toBe('$1.23');
  });
});

describe('longPeriodLabel / generatedOnLabel', () => {
  it('«Sep 26» → «Septiembre 2026» desde year/month', () => {
    expect(longPeriodLabel({ year: 2026, month: 9, label: 'Sep 26' })).toBe('Septiembre 2026');
  });

  it('sin year/month cae al label', () => {
    expect(longPeriodLabel({ label: 'Sep 26' })).toBe('Sep 26');
    expect(longPeriodLabel({ year: 2026, month: 13, label: 'X' })).toBe('X');
  });

  it('fecha de generación larga en castellano', () => {
    expect(generatedOnLabel(new Date(2026, 9, 5))).toBe('Generado el 5 de octubre de 2026');
  });
});

const wfBase = (over: Partial<WaterfallInput> = {}): WaterfallInput => ({
  desglose: SEP26,
  ingresosNetos: SEP26_INGRESOS,
  egresos: 208_084.45,
  saldo: 55_385.54,
  reservaMes: 5_538.55,
  reservePct: 0.1,
  deudaEntrada: 0,
  montoDistribuir: 49_846.99,
  ...over,
});

describe('buildCloseWaterfall — cómo se llega al resultado', () => {
  it('los componentes reales de sep-2026 suman 263.469,99: sin aviso', () => {
    const r = buildCloseWaterfall(wfBase());
    expect(r.diferenciaIngresos).toBeNull();
    expect(r.warnings.filter((w) => w.startsWith('Diferencia'))).toEqual([]);
    const s = SEP26.brokerPnl + SEP26.propFirmNetIncome + SEP26.investmentProfits + SEP26.other;
    expect(Math.round(s * 100) / 100).toBe(SEP26_INGRESOS);
  });

  it('Broker P&L y Prop Firm aparecen con su valor (era $0,00)', () => {
    const r = buildCloseWaterfall(wfBase());
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.amount]));
    expect(byLabel['Broker P&L']).toBe(226_605.2);
    expect(byLabel['Prop Firm neto']).toBe(13_248.27);
    expect(byLabel['Ganancias de inversiones']).toBe(23_616.52);
  });

  it('other = 0 no imprime renglón (detalle en cero se omite)', () => {
    const r = buildCloseWaterfall(wfBase());
    expect(r.rows.some((x) => x.label === 'Otros ingresos')).toBe(false);
  });

  it('un componente alterado ⇒ «Diferencia no explicada» con el monto', () => {
    const r = buildCloseWaterfall(wfBase({ desglose: { ...SEP26, brokerPnl: 226_600 } }));
    expect(r.diferenciaIngresos).toBe(-5.2);
    expect(r.warnings).toContain('Diferencia no explicada: -$5.20');
  });

  it('un centavo de redondeo NO es una diferencia', () => {
    const r = buildCloseWaterfall(wfBase({ ingresosNetos: SEP26_INGRESOS + 0.01 }));
    expect(r.diferenciaIngresos).toBeNull();
  });

  it('orden, signos y tipos: totales siempre, egresos en negativo', () => {
    const r = buildCloseWaterfall(wfBase());
    expect(r.rows.map((x) => [x.label, x.kind])).toEqual([
      ['Broker P&L', 'income'],
      ['Prop Firm neto', 'income'],
      ['Ganancias de inversiones', 'income'],
      ['Ingresos netos', 'total'],
      ['Egresos del mes', 'expense'],
      ['Resultado del mes', 'total'],
      ['Reserva del mes (10%)', 'expense'],
      ['A distribuir', 'total'],
    ]);
    expect(r.rows.find((x) => x.label === 'Egresos del mes')!.amount).toBe(-208_084.45);
    expect(r.diferenciaDistribucion).toBeNull();
  });

  it('cuadra contra la cadena canónica, con deuda arrastrada', () => {
    const chain = computeDistributionChain([
      { periodId: 'ago', brokerPnl: 0, other: 0, propFirmNetIncome: 0, investmentProfits: 0, totalExpenses: 20_000, reservePct: 0.1 },
      { periodId: 'sep', ...SEP26, totalExpenses: 208_084.45, reservePct: 0.1 },
    ]);
    const c = chain.get('sep')!;
    const r = buildCloseWaterfall({
      desglose: c.desglose,
      ingresosNetos: c.ingresosNetos,
      egresos: c.egresosNetos,
      saldo: c.saldoAFavor,
      reservaMes: c.reserveThisPeriod,
      reservePct: 0.1,
      deudaEntrada: c.deudaArrastradaEntrada,
      montoDistribuir: c.montoDistribuir,
    });
    expect(r.diferenciaIngresos).toBeNull();
    expect(r.diferenciaDistribucion).toBeNull();
    expect(r.rows.find((x) => x.label === 'Deuda arrastrada cubierta')!.amount).toBe(-20_000);
    expect(r.warnings).toEqual([]);
  });

  it('mes negativo: A distribuir 0 y la deuda que pasa se avisa', () => {
    const r = buildCloseWaterfall(
      wfBase({ egresos: 300_000, saldo: SEP26_INGRESOS - 300_000, reservaMes: 0, montoDistribuir: 0, deudaEntrada: 1_000 }),
    );
    expect(r.rows.at(-1)).toEqual({ label: 'A distribuir', amount: 0, kind: 'total' });
    expect(r.deudaQuePasa).toBe(37_530.01);
    expect(r.diferenciaDistribucion).toBeNull();
  });

  it('A distribuir que no sale de la cascada ⇒ aviso, no se esconde', () => {
    const r = buildCloseWaterfall(wfBase({ montoDistribuir: 50_000 }));
    expect(r.diferenciaDistribucion).toBe(-153.01);
    expect(r.warnings.some((w) => w.startsWith('Diferencia no explicada en la distribución'))).toBe(true);
  });

  it('subtexto de ingresos: solo los componentes con dato', () => {
    expect(incomeSourcesLabel(SEP26)).toBe('Broker + Prop Firm + Inversiones');
    expect(incomeSourcesLabel({ brokerPnl: 0, propFirmNetIncome: 0, investmentProfits: 0, other: 5 }, 'Facturación')).toBe('Facturación');
  });
});

describe('buildCloseExpenses — top 10 + «Otros N egresos»', () => {
  const exps = Array.from({ length: 13 }, (_, i) => ({
    concept: `E${i + 1}`,
    amount: (i + 1) * 100,
    paid: i % 2 === 0 ? (i + 1) * 100 : 0,
    pending: i % 2 === 0 ? 0 : (i + 1) * 100,
  }));

  it('la columna suma el total (top + otros)', () => {
    const r = buildCloseExpenses(exps, 10);
    expect(r.top).toHaveLength(10);
    expect(r.others).toEqual({ count: 3, amount: 600, share: 600 / 9100 });
    const col = r.top.reduce((s, e) => s + e.amount, 0) + (r.others?.amount ?? 0);
    expect(col).toBe(r.total);
    expect(r.total).toBe(9100);
  });

  it('estado pagado / pendiente / parcial y conteo de pagados', () => {
    const r = buildCloseExpenses([
      { concept: 'a', amount: 100, paid: 100, pending: 0 },
      { concept: 'b', amount: 100, paid: 0, pending: 100 },
      { concept: 'c', amount: 100, paid: 40, pending: 60 },
    ]);
    expect(r.top.map((e) => e.status)).toEqual(['pagado', 'pendiente', 'parcial']);
    expect(r.paidCount).toBe(1);
    expect(r.others).toBeNull();
  });
});

// ─── Flujo de clientes ──────────────────────────────────────────────────────

const ds = (slug: ProviderDataset['slug'], transactions: unknown[]): ProviderDataset =>
  ({
    slug,
    provider: slug.startsWith('coinsbuy') ? 'coinsbuy' : slug,
    kind: slug === 'coinsbuy-withdrawals' ? 'withdrawals' : 'deposits',
    transactions,
    fetchedAt: '2026-10-01T00:00:00Z',
    status: 'fresh',
    isMock: false,
  }) as unknown as ProviderDataset;

const flowBase = (over: Partial<ClientFlowInput> = {}): ClientFlowInput => ({
  derived: true,
  datasets: [
    ds('coinsbuy-deposits', [{ status: 'Confirmed', amountTarget: 1_000, commission: 0 }]),
    ds('coinsbuy-withdrawals', [{ status: 'Approved', chargedAmount: 400, commission: 0 }]),
    ds('fairpay', []),
    ds('unipayment', []),
    // Pay-Pros sep-2026: depósitos 'paid' y retiros 'payout_paid' en el MISMO slug.
    ds('paypros', [
      { status: 'paid', amount: 93_968.69 },
      { status: 'payout_paid', amount: 10_302.17 },
    ]),
  ],
  hiddenChannels: [],
  manualDeposits: [],
  manualWithdrawals: [],
  depositLabel: (c) => `dep:${c}`,
  withdrawalLabel: (c) => `wd:${c}`,
  withdrawalCategoryLabel: (c) => `cat:${c}`,
  ...over,
});

describe('buildClientFlow — canales desde el registro', () => {
  it('Pay-Pros entra en depósitos Y en retiros (93.968,69 / 10.302,17)', () => {
    const r = buildClientFlow(flowBase());
    expect(r.deposits).toContainEqual({ label: 'dep:paypros', amount: 93_968.69 });
    expect(r.withdrawals).toContainEqual({ label: 'wd:paypros', amount: 10_302.17 });
    expect(r.depositsTotal).toBe(94_968.69);
    expect(r.withdrawalsTotal).toBe(10_702.17);
    expect(r.netFlow).toBe(84_266.52);
    expect(r.warnings).toEqual([]);
  });

  it('recorre TODOS los canales del registro (agregar uno rompe este test)', () => {
    const r = buildClientFlow(
      flowBase({
        datasets: API_DEPOSIT_CHANNELS.map(({ slug }) => ds(slug, [])).concat(
          API_WITHDRAWAL_CHANNELS.filter((c) => c.slug !== 'paypros').map(({ slug }) => ds(slug, [])),
        ),
        manualDeposits: API_DEPOSIT_CHANNELS.map(({ channel }) => ({ channel, amount: 1 })),
      }),
    );
    expect(r.deposits.map((x) => x.label)).toEqual(API_DEPOSIT_CHANNELS.map(({ channel }) => `dep:${channel}`));
  });

  it('canal apagado para la empresa: no se imprime ni avisa', () => {
    const r = buildClientFlow(
      flowBase({ hiddenChannels: ['paypros', 'fairpay'], datasets: flowBase().datasets.filter((d) => d.slug !== 'paypros' && d.slug !== 'fairpay') }),
    );
    expect(r.deposits.some((x) => x.label === 'dep:paypros')).toBe(false);
    expect(r.withdrawals.some((x) => x.label === 'wd:paypros')).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('canal encendido sin dataset: «sin datos» (null), aviso y no suma', () => {
    const r = buildClientFlow(flowBase({ datasets: flowBase().datasets.filter((d) => d.slug !== 'paypros') }));
    expect(r.deposits).toContainEqual({ label: 'dep:paypros', amount: null });
    expect(r.withdrawals).toContainEqual({ label: 'wd:paypros', amount: null });
    expect(r.depositsTotal).toBe(1_000);
    expect(r.warnings.length).toBe(2);
  });

  it('canales en cero no imprimen renglón', () => {
    const r = buildClientFlow(flowBase());
    expect(r.deposits.some((x) => x.label === 'dep:fairpay')).toBe(false);
    expect(r.deposits.some((x) => x.label === 'dep:other')).toBe(false);
  });

  it('retiros: suma el manual Broker; IB / Prop Firm / Otros NO (igual que /movimientos)', () => {
    const r = buildClientFlow(
      flowBase({
        manualWithdrawals: [
          { category: 'broker', amount: 50 },
          { category: 'ib_commissions', amount: 9_999 },
          { category: 'prop_firm', amount: 9_999 },
        ],
      }),
    );
    expect(r.withdrawalsTotal).toBe(10_752.17);
    expect(r.withdrawals).toContainEqual({ label: 'cat:broker (manual)', amount: 50 });
  });

  it('lectura fallida: lo dice', () => {
    const r = buildClientFlow(flowBase({ fetchFailed: true, datasets: [] }));
    expect(r.warnings.some((w) => w.startsWith('No se pudieron leer'))).toBe(true);
  });

  it('período histórico: mandan los manuales guardados', () => {
    const r = buildClientFlow(
      flowBase({
        derived: false,
        datasets: [],
        manualDeposits: [{ channel: 'coinsbuy', amount: 300 }],
        manualWithdrawals: [{ category: 'broker', amount: 100 }],
      }),
    );
    expect(r.deposits).toEqual([{ label: 'dep:coinsbuy', amount: 300 }]);
    expect(r.withdrawals).toEqual([{ label: 'cat:broker', amount: 100 }]);
    expect(r.netFlow).toBe(200);
  });
});

describe('buildCrmInfoRows — informativo, no suma al resultado', () => {
  it('excluye las series que alimentan la cadena (prop firm)', () => {
    const keys = CRM_MONTHLY_OUTSIDE_RESULT_METRICS.map((m) => m.key);
    expect(keys).not.toContain('propfirm_sales');
    expect(keys).not.toContain('propfirm_withdrawals');
    expect(keys).toContain('p2p_transfers');
    expect(keys).toContain('ib_commissions');
  });

  it('solo el mes pedido, sin nulls ni ceros, rótulo del registro', () => {
    const ib = CRM_MONTHLY_METRICS.find((m) => m.key === 'ib_commissions')!;
    const rows = [
      { year: 2026, month: 9, metric: 'ib_commissions', auto: 150_000 },
      { year: 2026, month: 8, metric: 'ib_commissions', auto: 1 },
      { year: 2026, month: 9, metric: 'p2p_transfers', auto: null },
      { year: 2026, month: 9, metric: 'hedge_fund', auto: 0 },
      { year: 2026, month: 9, metric: 'propfirm_sales', auto: 99 },
    ];
    expect(buildCrmInfoRows(rows, CRM_MONTHLY_OUTSIDE_RESULT_METRICS, 2026, 9)).toEqual([
      { label: ib.labelEs, amount: 150_000 },
    ]);
  });

  it('sin datos del mes ⇒ vacío (el PDF omite la sección)', () => {
    expect(buildCrmInfoRows([], CRM_MONTHLY_OUTSIDE_RESULT_METRICS, 2026, 9)).toEqual([]);
  });
});
