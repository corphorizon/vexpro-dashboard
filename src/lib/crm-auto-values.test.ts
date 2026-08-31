import { describe, it, expect } from 'vitest';
import { resolveAutoOrManual, sumAutoForMonths } from './crm-auto-values';
import { computeDerivedBroker, computeDerivedNetDeposit } from './broker-logic';
import { CRM_MONTHLY_METRICS } from './crm-monthly';

// ─────────────────────────────────────────────────────────────────────────────
// La regla «el automático manda, el manual es override» y sus dos consecuencias
// de dinero: el P2P que estaba en cero, y las comisiones IB que arreglan el
// split sin tocar ningún total (auditoría de finanzas 2026-08-31, ítems 17/18).
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAutoOrManual', () => {
  it('en un período histórico manda el manual, aunque haya serie', () => {
    // Los meses viejos se cargaron a mano y se distribuyeron con esos números.
    expect(resolveAutoOrManual({ derived: false, manual: 9_787.04, auto: 999_999 })).toEqual({
      value: 9_787.04,
      source: 'manual',
    });
    // Incluso con manual en 0: en histórico el guardado es la verdad.
    expect(resolveAutoOrManual({ derived: false, manual: 0, auto: 136_213.42 })).toEqual({
      value: 0,
      source: 'manual',
    });
  });

  it('en un período derivado sin manual manda el automático', () => {
    expect(resolveAutoOrManual({ derived: true, manual: 0, auto: 29_403.67 })).toEqual({
      value: 29_403.67,
      source: 'api',
    });
  });

  it('un manual > 0 es un OVERRIDE explícito y gana', () => {
    expect(resolveAutoOrManual({ derived: true, manual: 5_000, auto: 29_403.67 })).toEqual({
      value: 5_000,
      source: 'manual',
    });
  });

  it('sin serie NO se inventa un número: cae al manual, rotulado manual', () => {
    // `null` es "no lo sabemos", y no saber no habilita a mostrar el automático
    // de otro mes ni un 0 con cara de dato.
    expect(resolveAutoOrManual({ derived: true, manual: 0, auto: null })).toEqual({
      value: 0,
      source: 'manual',
    });
  });

  it('un manual en 0 NO se trata como override', () => {
    // El default del input es 0: «cargó cero» y «no cargó» son indistinguibles,
    // y tratarlo como override dejaría la fila en cero para siempre — que es
    // exactamente el bug del P2P.
    expect(resolveAutoOrManual({ derived: true, manual: 0, auto: 31_629.8 }).source).toBe('api');
  });
});

describe('P2P del espejo (ítem 17)', () => {
  // Los valores reales de `crm_monthly_totals.p2p_transfers` de Vex Pro.
  const rows = [
    { year: 2025, month: 11, metric: 'p2p_transfers', auto: 9_787.04 },
    { year: 2025, month: 12, metric: 'p2p_transfers', auto: 136_213.42 },
    { year: 2026, month: 2, metric: 'p2p_transfers', auto: 76_693.78 },
    { year: 2026, month: 6, metric: 'p2p_transfers', auto: 39_474.91 },
    { year: 2026, month: 7, metric: 'p2p_transfers', auto: 31_629.8 },
    { year: 2026, month: 8, metric: 'p2p_transfers', auto: 29_403.67 },
    { year: 2026, month: 8, metric: 'propfirm_sales', auto: 11_198.7 },
  ];

  it('agosto deja de mostrar $0,00 y muestra 29.403,67', () => {
    const auto = sumAutoForMonths(rows, 'p2p_transfers', new Set(['2026-8']));
    expect(auto).toBe(29_403.67);
    expect(resolveAutoOrManual({ derived: true, manual: 0, auto })).toEqual({
      value: 29_403.67,
      source: 'api',
    });
  });

  it('nov-25 es el ÚNICO mes cargado a mano y coincide al centavo — se respeta', () => {
    // Es un período histórico Y un override: las dos razones apuntan al manual.
    const auto = sumAutoForMonths(rows, 'p2p_transfers', new Set(['2025-11']));
    expect(auto).toBe(9_787.04);
    const r = resolveAutoOrManual({ derived: false, manual: 9_787.04, auto });
    expect(r).toEqual({ value: 9_787.04, source: 'manual' });
    // Y si ese mes fuera derivado, el override seguiría ganando.
    expect(resolveAutoOrManual({ derived: true, manual: 9_787.04, auto }).source).toBe('manual');
  });

  it('un mes sin serie es null, no 0', () => {
    // Ene-2026 no está en las filas: el consolidado no puede fabricarle un cero.
    expect(sumAutoForMonths(rows, 'p2p_transfers', new Set(['2026-1']))).toBeNull();
  });

  it('un consolidado suma sólo los meses pedidos', () => {
    expect(sumAutoForMonths(rows, 'p2p_transfers', new Set(['2026-7', '2026-8']))).toBeCloseTo(
      61_033.47,
      2,
    );
  });

  it('no mezcla métricas', () => {
    expect(sumAutoForMonths(rows, 'propfirm_sales', new Set(['2026-8']))).toBe(11_198.7);
  });
});

describe('Comisiones IB (ítem 18): arreglan el split, NO el total', () => {
  // Agosto 2026, orden de magnitud medido: la API reporta el retiro completo y
  // la categoría IB manual está vacía desde abril.
  const apiWithdrawalsTotal = 469_650.98;
  const ibAuto = 152_000;
  const propFirm = 5_511.98;
  const other = 0;
  const manualBroker = 12_000;
  const apiDeposits = 700_000;
  const manualDepositsTotal = 25_000;

  const brokerAntes = computeDerivedBroker({
    apiWithdrawalsTotal,
    ibCommissions: 0, // la categoría vacía: TODO caía en Broker
    propFirm,
    other,
  });
  const brokerDespues = computeDerivedBroker({
    apiWithdrawalsTotal,
    ibCommissions: ibAuto,
    propFirm,
    other,
  });

  it('el split cambia: Broker deja de llevarse las comisiones IB', () => {
    expect(brokerAntes).toBeCloseTo(464_139.0, 2);
    expect(brokerDespues).toBeCloseTo(312_139.0, 2);
    expect(brokerAntes - brokerDespues).toBeCloseTo(ibAuto, 2);
  });

  it('la suma Broker + IB + PropFirm + Otros no se mueve', () => {
    // Es el total del pie del formulario de /upload: lo que se reparte es el
    // mismo importe, sólo cambia en qué renglón se apoya.
    const antes = brokerAntes + 0 + propFirm + other;
    const despues = brokerDespues + ibAuto + propFirm + other;
    expect(despues).toBeCloseTo(antes, 2);
    expect(despues).toBeCloseTo(apiWithdrawalsTotal, 2);
  });

  it('«Retiros Totales» y el Net Deposit NO dependen del IB', () => {
    // La fórmula canónica sólo mira la API y el manual de Broker: por eso
    // cablear el IB no puede tocar la cadena de distribución.
    const antes = computeDerivedNetDeposit({
      apiDeposits,
      manualDepositsTotal,
      apiWithdrawals: apiWithdrawalsTotal,
      manualBroker,
    });
    const despues = computeDerivedNetDeposit({
      apiDeposits,
      manualDepositsTotal,
      apiWithdrawals: apiWithdrawalsTotal,
      manualBroker,
    });
    expect(despues).toEqual(antes);
    expect(antes.totalWithdrawals).toBeCloseTo(481_650.98, 2);
  });

  it('la métrica sigue marcada como informativa en el registro', () => {
    // Si alguien le sacara `informational`, empezaría a compararse contra una
    // cifra manual que no existe y a invitar a sumarla. El test lo fija.
    const ib = CRM_MONTHLY_METRICS.find((m) => m.key === 'ib_commissions');
    expect(ib?.informational).toBe(true);
    expect(ib?.manualSource).toBeNull();
  });
});
