// Home del admin: avisos por severidad (3 visibles + «ver todas»), variación
// vs. el mes anterior y saldo corrido, sin inventar ceros.
import { describe, it, expect } from 'vitest';
import { homeAlerts, pctChange, runningBalance, visibleAlerts, type HomeAlertsInput } from './home-view';

const BASE: HomeAlertsInput = {
  totalState: 'ready',
  monthSeries: null,
  monthNotice: null,
  withdrawalChannelsWithoutData: [],
  truncatedSlices: [],
  driftPeriods: [],
  checklist: { state: 'ready', items: [] },
  periodLabel: 'Oct 26',
};

describe('homeAlerts', () => {
  it('todo en orden: ninguna alerta', () => {
    expect(homeAlerts(BASE)).toEqual([]);
    expect(homeAlerts({ ...BASE, totalState: null, checklist: null })).toEqual([]);
  });

  it('total consolidado que no se pudo leer → bad (antes era «$0.00»)', () => {
    expect(homeAlerts({ ...BASE, totalState: 'failed' })).toEqual([
      { id: 'total-failed', kind: 'bad', title: { key: 'home.alert.totalFailed' }, href: '/balances' },
    ]);
    // Cargando no es un problema.
    expect(homeAlerts({ ...BASE, totalState: 'loading' })).toEqual([]);
  });

  it('serie del CRM: el banner usa el kind de seriesState y el texto de incompleteNotice', () => {
    const [a] = homeAlerts({
      ...BASE,
      monthSeries: { phase: 'loading', label: 'Cargando datos del CRM…', badge: 'stale', notice: 'stale' },
      monthNotice: 'Broker P&L: esperando datos del CRM — el informe está incompleto',
    });
    expect(a).toMatchObject({
      kind: 'stale',
      title: { text: 'Broker P&L: esperando datos del CRM — el informe está incompleto' },
      detail: { key: 'home.alert.crmLoading' },
    });
  });

  it('checklist: bloqueante → bad, advertencia → pend, con conteo; los de conteo 0 no salen', () => {
    const alerts = homeAlerts({
      ...BASE,
      checklist: {
        state: 'ready',
        items: [
          { key: 'orders_approved_unpaid', labelKey: 'periodClose.ordersUnpaid', count: 3, detail: 'OP-12, OP-15', severity: 'warning' },
          { key: 'expenses_no_proof', labelKey: 'periodClose.expensesNoProof', count: 0, detail: null, severity: 'warning' },
          { key: 'earlier_periods_open', labelKey: 'periodClose.earlierPeriodsOpen', count: 1, detail: null, severity: 'blocking' },
        ],
      },
    });
    expect(alerts.map((a) => [a.id, a.kind, a.count])).toEqual([
      ['checklist-earlier_periods_open', 'bad', 1],
      ['checklist-orders_approved_unpaid', 'pend', 3],
    ]);
    expect(alerts[1].detail).toEqual({ text: 'OP-12, OP-15' });
  });

  it('checklist que no respondió → info (se dice, no se calla); cargando no avisa', () => {
    expect(homeAlerts({ ...BASE, checklist: { state: 'failed', items: [] } })[0]).toMatchObject({
      id: 'checklist-failed',
      kind: 'info',
      title: { key: 'home.alert.checklistFailed', params: { period: 'Oct 26' } },
    });
    expect(homeAlerts({ ...BASE, checklist: { state: 'loading', items: [] } })).toEqual([]);
  });

  it('ordena por severidad bad > pend > stale > info, estable dentro de cada una', () => {
    const alerts = homeAlerts({
      ...BASE,
      totalState: 'failed',
      monthSeries: { phase: 'loading', label: 'x', badge: 'stale', notice: 'stale' },
      monthNotice: 'serie',
      withdrawalChannelsWithoutData: ['Coinsbuy'],
      truncatedSlices: ['expenses'],
      driftPeriods: ['Jun 26', 'Jul 26'],
      checklist: { state: 'failed', items: [] },
    });
    expect(alerts.map((a) => [a.id, a.kind])).toEqual([
      ['total-failed', 'bad'],
      ['drift', 'bad'],
      ['withdrawal-channels', 'pend'],
      ['truncated', 'pend'],
      ['crm-series', 'stale'],
      ['checklist-failed', 'info'],
    ]);
    expect(alerts.find((a) => a.id === 'drift')?.title).toEqual({ key: 'home.alert.drift', params: { n: '2' } });
  });
});

describe('visibleAlerts — 3 visibles + «ver todas (N)»', () => {
  it('recorta a 3 y cuenta lo oculto; expandido muestra todo', () => {
    const list = [1, 2, 3, 4, 5];
    expect(visibleAlerts(list, false)).toEqual({ shown: [1, 2, 3], hidden: 2 });
    expect(visibleAlerts(list, true)).toEqual({ shown: list, hidden: 0 });
    expect(visibleAlerts([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe('pctChange', () => {
  it('variación % sobre el valor absoluto del anterior', () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(-50, -100)).toBeCloseTo(50);
  });
  it('sin base (anterior 0 o sin dato) → null, nunca Infinity ni 0', () => {
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
  });
});

describe('runningBalance', () => {
  it('Σ depósito − retiro + profit, en centavos', () => {
    expect(runningBalance([{ deposit: 1000 }, { withdrawal: 200.1 }, { profit: 0.2 }])).toBe(800.1);
  });
  it('sin movimientos → null («—», no «$0.00»)', () => {
    expect(runningBalance([])).toBeNull();
  });
});
