// ─────────────────────────────────────────────────────────────────────────────
// Checklist de cierre — auditoría de finanzas, ítem 22.
//
// Los tres casos que motivaron los chequeos nuevos están acá con sus números
// REALES de producción (medidos el 2026-08-31), así que si alguien afloja un
// umbral, el test dice exactamente qué plata se vuelve a escapar.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKLIST_LABEL_KEYS,
  CRM_DRIFT_METRICS,
  FAIRPAY_ADJUSTMENT_METRIC,
  checkFairpayAdjustment,
  computeAccrualCashGap,
  computeCrmDrift,
  earlierOpenPeriods,
} from './period-close-checklist';
import { CRM_MONTHLY_METRIC_KEYS } from './crm-monthly';

describe('deriva contra el CRM', () => {
  it('Feb-26: los $2.373,37 de retiros prop firm que no se cargaron', () => {
    const drifts = computeCrmDrift([
      { key: 'propfirm_sales', manual: 51_409.65, crm: 51_409.65 },
      { key: 'propfirm_withdrawals', manual: 0, crm: 2_373.37 },
    ]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].key).toBe('propfirm_withdrawals');
    expect(drifts[0].diff).toBeCloseTo(-2_373.37, 2);
  });

  it('Jul-26: +68,80 sobre 14.645 (0,47%) NO dispara — es ruido', () => {
    expect(
      computeCrmDrift([
        { key: 'propfirm_sales', manual: 14_714, crm: 14_645.2 },
        { key: 'propfirm_withdrawals', manual: 5_511, crm: 5_511.98 },
      ]),
    ).toEqual([]);
  });

  it('Ago-26: nada cargado y el CRM con 11.981,70 sí dispara', () => {
    const drifts = computeCrmDrift([{ key: 'propfirm_sales', manual: 0, crm: 11_981.7 }]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].diff).toBeCloseTo(-11_981.7, 2);
  });

  it('el CRM sin ese mes NO es una deriva — null ≠ 0 (§1.3)', () => {
    expect(computeCrmDrift([{ key: 'propfirm_sales', manual: 4_883, crm: null }])).toEqual([]);
  });

  it('coincidencia exacta no dispara', () => {
    expect(
      computeCrmDrift([{ key: 'propfirm_withdrawals', manual: 5_754.15, crm: 5_754.15 }]),
    ).toEqual([]);
  });

  it('una diferencia de centavos no dispara', () => {
    expect(computeCrmDrift([{ key: 'propfirm_sales', manual: 16_091, crm: 16_091.1 }])).toEqual([]);
  });

  it('un manual de más también es deriva (no sólo el de menos)', () => {
    const drifts = computeCrmDrift([{ key: 'propfirm_sales', manual: 13_323, crm: 4_883 }]);
    expect(drifts[0].diff).toBeCloseTo(8_440, 2);
  });

  it('sólo se comparan las métricas que mueven la base distribuible', () => {
    // `ib_commissions` y `p2p_transfers` están en crm_monthly_totals pero NO
    // acá: son informativas y compararlas haría que los 11 períodos de Vex Pro
    // gritaran siempre.
    expect(CRM_DRIFT_METRICS.map((m) => m.key)).toEqual([
      'propfirm_sales',
      'propfirm_withdrawals',
    ]);
  });
});

describe('salto devengado / caja de los egresos', () => {
  it('Horizon Ago-26: los −$5.365 que el cierre le habría cambiado', () => {
    expect(
      computeAccrualCashGap({
        businessModel: 'company',
        totalAccrued: 21_928.23,
        totalPaid: 16_563.23,
      }),
    ).toBeCloseTo(-5_365, 2);
  });

  it('un broker no tiene salto: las dos bases son devengado', () => {
    expect(
      computeAccrualCashGap({ businessModel: 'broker', totalAccrued: 100, totalPaid: 40 }),
    ).toBeNull();
  });

  it('sin modelo declarado no se inventa el chequeo', () => {
    expect(
      computeAccrualCashGap({ businessModel: null, totalAccrued: 100, totalPaid: 40 }),
    ).toBeNull();
  });

  it('todo pagado = sin salto (Horizon, Jul-26)', () => {
    expect(
      computeAccrualCashGap({
        businessModel: 'company',
        totalAccrued: 27_351.43,
        totalPaid: 27_351.43,
      }),
    ).toBe(0);
  });

  it('0 y null son cosas distintas: 0 es "lo miré y no hay salto"', () => {
    const sinSalto = computeAccrualCashGap({
      businessModel: 'company',
      totalAccrued: 10,
      totalPaid: 10,
    });
    const noAplica = computeAccrualCashGap({
      businessModel: 'broker',
      totalAccrued: 10,
      totalPaid: 10,
    });
    expect(sinSalto).toBe(0);
    expect(noAplica).toBeNull();
    expect(sinSalto).not.toBe(noAplica);
  });
});

describe('egreso «Ajuste FairPay» del mes', () => {
  it('Ago-26 está CUBIERTO: el egreso histórico de $2.994,83 ya está cargado', () => {
    // El primer egreso cubre abr→ago 2026 entero y vive en Ago-26. El chequeo
    // sobre ese período no puede pedir otro.
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 44,
        crmAdjustment: 432.05,
        expenseLoaded: true,
      }),
    ).toEqual({ state: 'covered', amount: 432.05 });
  });

  it('un mes con ajuste y sin egreso queda PENDIENTE', () => {
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 161,
        crmAdjustment: 1_260.71,
        expenseLoaded: false,
      }),
    ).toEqual({ state: 'missing', amount: 1_260.71 });
  });

  it('sin métrica del CRM dice «sin dato», NO $0 (§1.3)', () => {
    // El caso peligroso: el sync no corrió. Asumir cero cerraría el mes
    // afirmando que no hubo recargo, que es un número plausible y falso.
    const r = checkFairpayAdjustment({
      fairpayPaymentsInMonth: 44,
      crmAdjustment: null,
      expenseLoaded: false,
    });
    expect(r).toEqual({ state: 'no_data' });
    expect(r).not.toEqual({ state: 'nothing_to_load', amount: 0 });
  });

  it('«sin dato» tampoco se tapa porque el egreso esté cargado', () => {
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 44,
        crmAdjustment: null,
        expenseLoaded: true,
      }),
    ).toEqual({ state: 'no_data' });
  });

  it('un mes sin pagos de FairPay no genera el ítem', () => {
    // Vex Pro antes de abril de 2026, y todas las empresas sin el canal. Un
    // checklist que siempre grita enseña a cerrar sin leer.
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 0,
        crmAdjustment: null,
        expenseLoaded: false,
      }),
    ).toEqual({ state: 'not_applicable' });
  });

  it('un ajuste calculado en cero no pide egreso, pero se informa', () => {
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 12,
        crmAdjustment: 0,
        expenseLoaded: false,
      }),
    ).toEqual({ state: 'nothing_to_load', amount: 0 });
  });

  it('un ajuste negativo tampoco pide egreso (y no se recorta a 0)', () => {
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 12,
        crmAdjustment: -3.5,
        expenseLoaded: false,
      }),
    ).toEqual({ state: 'nothing_to_load', amount: -3.5 });
  });

  it('un NaN se trata como «sin dato», no como cero', () => {
    expect(
      checkFairpayAdjustment({
        fairpayPaymentsInMonth: 12,
        crmAdjustment: Number.NaN,
        expenseLoaded: false,
      }),
    ).toEqual({ state: 'no_data' });
  });

  it('la métrica que se busca existe en el registro único del CRM', () => {
    // Un typo acá dejaría el chequeo diciendo «sin dato» para siempre, con la
    // serie calculada al lado.
    expect(CRM_MONTHLY_METRIC_KEYS).toContain(FAIRPAY_ADJUSTMENT_METRIC);
  });
});

describe('orden cronológico de cierre', () => {
  const vexPro = [
    { id: 'a', year: 2026, month: 6, label: 'Jun 26', isClosed: true },
    { id: 'b', year: 2026, month: 7, label: 'Jul 26', isClosed: false },
    { id: 'c', year: 2026, month: 8, label: 'Ago 26', isClosed: false },
  ];

  it('cerrar Ago con Jul abierto: Jul aparece como pendiente', () => {
    const open = earlierOpenPeriods(vexPro, { year: 2026, month: 8 });
    expect(open.map((p) => p.label)).toEqual(['Jul 26']);
  });

  it('cerrar Jul (el más viejo abierto) no tiene nada anterior', () => {
    expect(earlierOpenPeriods(vexPro, { year: 2026, month: 7 })).toEqual([]);
  });

  it('el orden cruza el año, no compara sólo el mes', () => {
    const periodos = [
      { id: 'a', year: 2025, month: 12, label: 'Dic 25', isClosed: false },
      { id: 'b', year: 2026, month: 1, label: 'Ene 26', isClosed: false },
    ];
    expect(earlierOpenPeriods(periodos, { year: 2026, month: 1 }).map((p) => p.label)).toEqual([
      'Dic 25',
    ]);
    expect(earlierOpenPeriods(periodos, { year: 2025, month: 12 })).toEqual([]);
  });

  it('los pendientes salen del más viejo al más nuevo', () => {
    const periodos = [
      { id: 'c', year: 2026, month: 3, label: 'Mar 26', isClosed: false },
      { id: 'a', year: 2026, month: 1, label: 'Ene 26', isClosed: false },
      { id: 'b', year: 2026, month: 2, label: 'Feb 26', isClosed: false },
    ];
    expect(earlierOpenPeriods(periodos, { year: 2026, month: 4 }).map((p) => p.label)).toEqual([
      'Ene 26',
      'Feb 26',
      'Mar 26',
    ]);
  });

  it('el estado real de Vex Pro (9 cerrados contiguos) no queda bloqueado', () => {
    // Verificado en producción: Oct-25 … Jun-26 cerrados, Jul y Ago abiertos.
    // Exigir el orden NO rompe ningún cierre existente.
    const periodos = [
      ...[10, 11, 12].map((m) => ({ id: `25-${m}`, year: 2025, month: m, label: `M${m}`, isClosed: true })),
      ...[1, 2, 3, 4, 5, 6].map((m) => ({ id: `26-${m}`, year: 2026, month: m, label: `M${m}`, isClosed: true })),
      { id: '26-7', year: 2026, month: 7, label: 'Jul 26', isClosed: false },
      { id: '26-8', year: 2026, month: 8, label: 'Ago 26', isClosed: false },
    ];
    expect(earlierOpenPeriods(periodos, { year: 2026, month: 7 })).toEqual([]);
  });
});

describe('i18n — ningún ítem muestra la clave cruda', () => {
  const i18n = readFileSync(join(process.cwd(), 'src', 'lib', 'i18n.tsx'), 'utf8');

  // Iterar sobre el registro único: agregar un chequeo sin su traducción
  // rompe el test en vez de aparecer como `periodClose.loQueSea` en pantalla.
  for (const [item, key] of Object.entries(CHECKLIST_LABEL_KEYS)) {
    it(`${item} tiene texto en los dos idiomas`, () => {
      const occurrences = i18n.split(`'${key}':`).length - 1;
      expect(occurrences).toBe(2); // en + es
    });
  }

  for (const metric of CRM_DRIFT_METRICS) {
    it(`la métrica ${metric.key} tiene texto en los dos idiomas`, () => {
      expect(i18n.split(`'${metric.labelKey}':`).length - 1).toBe(2);
    });
  }
});

describe('migración 111 — el cierre queda escrito y respeta el orden', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migration-111-checklist-de-cierre.sql'),
    'utf8',
  );

  it('crea la tabla del checklist congelado con RLS', () => {
    expect(sql).toMatch(/create table if not exists public\.period_close_checklists/);
    expect(sql).toMatch(/alter table public\.period_close_checklists enable row level security/);
  });

  it('la tabla NO tiene policies de escritura (escribe el service role)', () => {
    expect(sql).not.toMatch(/create policy \w+ *\n? *on public\.period_close_checklists *\n? *for (insert|update|delete)/i);
  });

  it('el bloqueo por orden va ANTES de congelar el snapshot', () => {
    const guardIdx = sql.indexOf('meses anteriores abiertos');
    const snapshotIdx = sql.indexOf('into v_snapshot');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(snapshotIdx);
  });

  it('compara año*100+mes, no sólo el mes', () => {
    expect(sql).toMatch(/\(p\.year \* 100 \+ p\.month\) < \(v_period\.year \* 100 \+ v_period\.month\)/);
  });

  it('conserva los grants de la 061 (sólo service_role)', () => {
    expect(sql).toMatch(/revoke all on function public\.close_period\(uuid, uuid, uuid, text\) from public, anon;/);
    expect(sql).toMatch(/grant execute on function public\.close_period\(uuid, uuid, uuid, text\) to service_role;/);
  });

  it('no pierde ninguna clave del snapshot de la 061', () => {
    for (const key of [
      'period_label', 'reserve_pct', 'broker_pnl', 'other_income', 'prop_firm_sales',
      'prop_firm_withdrawals', 'investment_profits', 'total_expenses', 'total_deposits',
      'total_withdrawals', 'frozen_at',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
  });
});
