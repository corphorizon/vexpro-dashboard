import { describe, it, expect } from 'vitest';
import { isUnknownConcept } from './crm-wallet-concepts';
import {
  CRM_MONTHLY_METRICS,
  CRM_MONTHLY_METRIC_KEYS,
  CRM_MONTHLY_COMPARED_METRICS,
  CRM_MONTHLY_INFO_METRICS,
  WALLET_METRIC_SPECS,
  aggregateWalletMetricByMonth,
  type WalletConceptMonthRow,
  aggregateP2pByMonth,
  aggregatePropfirmSalesByMonth,
  aggregatePropfirmWithdrawalsByMonth,
  aggregateWalletPropfirmByMonth,
  monthKeyUtc,
  splitMonthKey,
} from './crm-monthly';

// ─────────────────────────────────────────────────────────────────────────────
// Lo que estos tests fijan es la DECISIÓN, no el plumbing: qué lado del P2P se
// cuenta, qué se excluye y con qué fecha cae cada cosa en su mes. Los casos
// negativos son la mitad, porque el bug de este repo no lanza excepciones:
// devuelve un número plausible y equivocado.
// ─────────────────────────────────────────────────────────────────────────────

const OK = new Map([['t1', 'COMPLETED']]);

describe('monthKeyUtc', () => {
  it('usa UTC y no la zona del proceso', () => {
    // 23:30 UTC del 31 de enero. En cualquier zona al oeste de Greenwich,
    // getMonth() local diría enero igual; en Asia diría febrero. UTC no.
    expect(monthKeyUtc('2026-01-31T23:30:00.000Z')).toBe('2026-01');
    expect(monthKeyUtc(new Date('2026-02-01T00:30:00.000Z'))).toBe('2026-02');
  });

  it('devuelve null para lo que no es fecha (no un mes cualquiera)', () => {
    expect(monthKeyUtc(null)).toBeNull();
    expect(monthKeyUtc(undefined)).toBeNull();
    expect(monthKeyUtc('')).toBeNull();
    expect(monthKeyUtc('no es una fecha')).toBeNull();
  });

  it('splitMonthKey rechaza claves imposibles', () => {
    expect(splitMonthKey('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(splitMonthKey('2026-13')).toBeNull();
    expect(splitMonthKey('2026-00')).toBeNull();
    expect(splitMonthKey('2026-7')).toBeNull();
    expect(splitMonthKey('basura')).toBeNull();
  });
});

describe('aggregateP2pByMonth', () => {
  const leg = (over: Record<string, unknown> = {}) => ({
    walletTransferType: 'OUT',
    netAmount: 100,
    grossAmount: 100,
    walletTransferDate: '2026-07-10T12:00:00.000Z',
    relatedConceptId: 't1',
    ...over,
  });

  it('cuenta el lado OUT y NO suma el IN: es el mismo dinero', () => {
    const r = aggregateP2pByMonth([leg(), leg({ walletTransferType: 'IN' })], OK);
    const b = r.get('2026-07')!;
    expect(b.amount).toBe(100);
    expect(b.count).toBe(1);
    // El otro lado queda como contraste, no como total.
    expect(b.cross.inSide).toBe(100);
  });

  it('excluye las transferencias no completadas, y las cuenta', () => {
    // El caso medido en AP Markets: un rechazado sale y vuelve al MISMO
    // usuario. Contarlo inflaría julio en $2.000 que nunca cambiaron de dueño.
    const estados = new Map([['t1', 'COMPLETED'], ['t2', 'REJECTED']]);
    const r = aggregateP2pByMonth(
      [leg(), leg({ relatedConceptId: 't2', netAmount: 2000 })],
      estados,
    );
    const b = r.get('2026-07')!;
    expect(b.amount).toBe(100);
    expect(b.excludedCount).toBe(1);
    expect(b.excludedAmount).toBe(2000);
  });

  it('excluye las patas sin estado, y las cuenta aparte', () => {
    const r = aggregateP2pByMonth([leg({ relatedConceptId: 'fantasma', netAmount: 50 })], OK);
    const b = r.get('2026-07')!;
    expect(b.amount).toBe(0);
    expect(b.excludedCount).toBe(1);
    expect(b.cross.noStatusCount).toBe(1);
    expect(b.cross.noStatusAmount).toBe(50);
  });

  it('ignora patas sin fecha, sin dirección o sin monto en vez de contarlas como cero', () => {
    const r = aggregateP2pByMonth(
      [
        leg({ walletTransferDate: null }),
        leg({ walletTransferType: 'INTERNAL' }),
        leg({ netAmount: null }),
        leg({ netAmount: 'no es un número' }),
      ],
      OK,
    );
    expect(r.size).toBe(0);
  });

  it('reparte por mes con el borde en UTC', () => {
    const r = aggregateP2pByMonth(
      [
        leg({ walletTransferDate: '2026-07-31T23:59:59.000Z' }),
        leg({ walletTransferDate: '2026-08-01T00:00:01.000Z', netAmount: 7 }),
      ],
      OK,
    );
    expect(r.get('2026-07')!.amount).toBe(100);
    expect(r.get('2026-08')!.amount).toBe(7);
  });
});

describe('aggregatePropfirmSalesByMonth', () => {
  it('suma lo COBRADO (amountPaid), no el precio de lista', () => {
    const r = aggregatePropfirmSalesByMonth([
      { price: 100, amountPaid: 80, discountAmount: 20, createdAt: '2026-02-05T00:00:00.000Z' },
    ]);
    const b = r.get('2026-02')!;
    expect(b.amount).toBe(80);
    expect(b.cross.listPrice).toBe(100);
    expect(b.cross.discount).toBe(20);
  });

  it('una compra sin cobro no es una venta: se cuenta aparte', () => {
    const r = aggregatePropfirmSalesByMonth([
      { price: 100, amountPaid: 0, discountAmount: 100, createdAt: '2026-02-05T00:00:00.000Z' },
      { price: 50, amountPaid: null, createdAt: '2026-02-06T00:00:00.000Z' },
    ]);
    const b = r.get('2026-02')!;
    expect(b.amount).toBe(0);
    expect(b.count).toBe(0);
    expect(b.excludedCount).toBe(2);
    expect(b.excludedAmount).toBe(150);
  });

  it('descarta las compras sin createdAt en vez de meterlas en un mes cualquiera', () => {
    const r = aggregatePropfirmSalesByMonth([{ price: 100, amountPaid: 100, createdAt: null }]);
    expect(r.size).toBe(0);
  });
});

describe('aggregatePropfirmWithdrawalsByMonth', () => {
  it('suma la parte del TRADER, no la ganancia bruta, y en el mes en que se PAGÓ', () => {
    const r = aggregatePropfirmWithdrawalsByMonth([
      {
        status: 'APPROVED',
        requestedAmount: 500,
        profitUserValue: 400,
        requestedDate: '2026-06-30T23:00:00.000Z',
        authorizedDate: '2026-07-01T02:00:00.000Z',
      },
    ]);
    const b = r.get('2026-07')!;
    expect(b.amount).toBe(400);
    expect(b.cross.requested).toBe(500);
    expect(r.get('2026-06')).toBeUndefined();
  });

  it('un aprobado SIN la parte del trader no se cuenta con el bruto', () => {
    const r = aggregatePropfirmWithdrawalsByMonth([
      { status: 'APPROVED', requestedAmount: 500, profitUserValue: null, requestedDate: '2026-07-02T00:00:00.000Z', authorizedDate: '2026-07-03T00:00:00.000Z' },
    ]);
    const b = r.get('2026-07')!;
    expect(b.amount).toBe(0);
    expect(b.excludedCount).toBe(1);
    expect(b.excludedAmount).toBe(500);
  });

  it('un rechazado no es un egreso: fuera del total y contado', () => {
    const r = aggregatePropfirmWithdrawalsByMonth([
      { status: 'REJECTED', requestedAmount: 30093.4, profitUserValue: 22756.7, requestedDate: '2026-03-10T00:00:00.000Z', authorizedDate: '2026-03-11T00:00:00.000Z' },
    ]);
    const b = r.get('2026-03')!;
    expect(b.amount).toBe(0);
    expect(b.excludedCount).toBe(1);
    expect(b.excludedAmount).toBe(22756.7);
  });

  it('un aprobado SIN fecha de pago no inventa un mes de pago', () => {
    const r = aggregatePropfirmWithdrawalsByMonth([
      { status: 'APPROVED', requestedAmount: 300, profitUserValue: 240, requestedDate: '2026-05-02T00:00:00.000Z', authorizedDate: null },
    ]);
    const b = r.get('2026-05')!;
    expect(b.amount).toBe(0);
    expect(b.excludedCount).toBe(1);
  });

  it('un pendiente sin ninguna fecha no entra a ningún mes', () => {
    const r = aggregatePropfirmWithdrawalsByMonth([
      { status: 'PENDING', requestedAmount: 8366.36, profitUserValue: 6693.09, requestedDate: null, authorizedDate: null },
    ]);
    expect(r.size).toBe(0);
  });
});

describe('aggregateWalletPropfirmByMonth', () => {
  it('suma la pata OUT de la billetera, que es el contraste de las ventas', () => {
    const r = aggregateWalletPropfirmByMonth([
      { walletTransferType: 'OUT', netAmount: 20, walletTransferDate: '2026-08-01T00:00:00.000Z' },
      { walletTransferType: 'IN', netAmount: 999, walletTransferDate: '2026-08-01T00:00:00.000Z' },
    ]);
    expect(r.get('2026-08')).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Métricas INFORMATIVAS (comisiones IB, social trading fees, fee debt
// recovery). Lo que se fija acá es lo que se midió contra los documentos
// reales el 2026-08-28: la dirección que suma, que el bruto no se usa, que el
// reverso no es un fee, y —sobre todo— que nada se traga en silencio.
// ─────────────────────────────────────────────────────────────────────────────

const IB_SPEC = WALLET_METRIC_SPECS.find((s) => s.metric === 'ib_commissions')!;
const SOCIAL_SPEC = WALLET_METRIC_SPECS.find((s) => s.metric === 'social_trading_fees')!;
const FEE_DEBT_SPEC = WALLET_METRIC_SPECS.find((s) => s.metric === 'fee_debt_recovery')!;

const fila = (o: Partial<WalletConceptMonthRow> & { concept: string }): WalletConceptMonthRow => ({
  direction: 'IN',
  monthKey: '2026-07',
  count: 1,
  net: 0,
  gross: 0,
  ...o,
});

describe('aggregateWalletMetricByMonth', () => {
  it('suma la dirección de la métrica y usa el NETO, no el bruto', () => {
    // El caso real: IB_PROP_FIRM_REWARD trae gross 629.868,70 contra net
    // 22.357,85 en Vex Pro. Sumar el bruto multiplica la serie por 28.
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'IB_PROP_FIRM_REWARD', net: 7, gross: 35, count: 3 })],
      IB_SPEC,
    );
    const b = r.buckets.get('2026-07')!;
    expect(b.amount).toBe(7);
    expect(b.count).toBe(3);
    expect(b.cross.gross).toBe(35);
  });

  it('la pata contraria es una corrección: NO suma, pero se cuenta y se informa', () => {
    // Vex Pro: 3 patas OUT de IB_REWARDS_BROKER por $1.843,74
    // ("IB REWARDS (Correction)" y "Ajuste mar-26").
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'IB_REWARDS_BROKER', net: 100, gross: 100 }),
        fila({ concept: 'IB_REWARDS_BROKER', direction: 'OUT', net: 505, count: 2 }),
      ],
      IB_SPEC,
    );
    const b = r.buckets.get('2026-07')!;
    expect(b.amount).toBe(100);
    expect(b.excludedAmount).toBe(505);
    expect(b.excludedCount).toBe(2);
  });

  it('fee debt recovery suma la pata OUT, que es la que existe', () => {
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'FEE_DEBT_RECOVERY', direction: 'OUT', net: 8.72 })],
      FEE_DEBT_SPEC,
    );
    expect(r.buckets.get('2026-07')!.amount).toBe(8.72);
  });

  it('el reverso de un fee NO es un fee: va al contraste, no al total', () => {
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'SOCIAL_PERFORMANCE_FEE', net: 123.32, gross: 123.32 }),
        fila({ concept: 'PERFORMANCE_FEE_REVERSAL', net: 467.1 }),
      ],
      SOCIAL_SPEC,
    );
    const b = r.buckets.get('2026-07')!;
    expect(b.amount).toBe(123.32);
    expect(b.cross.reversals).toBe(467.1);
  });

  it('un concepto de la familia que la métrica no clasifica NO se traga: se cuenta y se avisa', () => {
    // El día que el broker agregue un concepto IB nuevo, tiene que VERSE. La
    // alternativa —ignorarlo— devuelve un total plausible y equivocado, que
    // es el modo de falla de este repo.
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'IB_REWARDS_BROKER', net: 10, gross: 10 }),
        fila({ concept: 'IB_MISTERIO_NUEVO', net: 999, count: 4 }),
      ],
      IB_SPEC,
    );
    expect(r.buckets.get('2026-07')!.amount).toBe(10);
    expect(r.unclassified.get('IB_MISTERIO_NUEVO')).toEqual({ count: 4, amount: 999 });
  });

  it('un movimiento sin mes utilizable no se inventa un mes: queda contado aparte', () => {
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'IB_REWARDS_BROKER', monthKey: null, net: 50, count: 2 }),
        fila({ concept: 'IB_REWARDS_BROKER', monthKey: '2026-13', net: 30, count: 1 }),
      ],
      IB_SPEC,
    );
    expect(r.buckets.size).toBe(0);
    expect(r.noMonth).toEqual({ count: 3, amount: 80 });
  });

  it('un mes sin movimientos no existe: "sin datos" no es "$0"', () => {
    // AP Markets no tiene un solo FEE_DEBT_RECOVERY. Devolver un mes en cero
    // diría "no se recuperó nada", que es una afirmación que no tenemos.
    const r = aggregateWalletMetricByMonth([], FEE_DEBT_SPEC);
    expect(r.buckets.size).toBe(0);
  });

  it('un mes con movimientos reales sí puede dar cero, y eso SÍ es un cero', () => {
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'IB_REWARDS_BROKER', net: 0, gross: 0, count: 1757 })],
      IB_SPEC,
    );
    // 1.757 acreditaciones de IB con netAmount 0 existen de verdad en Vex Pro.
    expect(r.buckets.get('2026-07')!.amount).toBe(0);
    expect(r.buckets.get('2026-07')!.count).toBe(1757);
  });

  it('separa los meses y redondea a dos decimales', () => {
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'IB_REWARDS_BROKER', monthKey: '2026-06', net: 16.7277667969 }),
        fila({ concept: 'IB_REWARDS_BROKER', monthKey: '2026-07', net: 1.006 }),
      ],
      IB_SPEC,
    );
    expect(r.buckets.get('2026-06')!.amount).toBe(16.73);
    expect(r.buckets.get('2026-07')!.amount).toBe(1.01);
  });
});

describe('registro de métricas', () => {
  it('no tiene claves repetidas', () => {
    expect(new Set(CRM_MONTHLY_METRIC_KEYS).size).toBe(CRM_MONTHLY_METRIC_KEYS.length);
  });

  it('cada métrica dice contra qué manual se compara, para que nadie las sume', () => {
    // Se itera el registro: agregar una métrica sin declarar su manual rompe
    // el test en vez de pasar desapercibido.
    for (const m of CRM_MONTHLY_METRICS) {
      expect(m.key).toMatch(/^[a-z0-9_]+$/);
      expect(m.labelEs.length).toBeGreaterThan(0);
      expect(m.labelEn.length).toBeGreaterThan(0);
      if (m.informational) {
        // Las informativas NO se comparan con nada: declarar un manual sería
        // invitar a restarlas contra una cifra de finanzas.
        expect(m.manualSource).toBeNull();
        // Y tienen que decir POR QUÉ no cuentan, en los dos idiomas: la
        // advertencia de la pantalla sale de acá.
        expect(m.whyNotFinanceEs?.length ?? 0).toBeGreaterThan(0);
        expect(m.whyNotFinanceEn?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(m.manualSource?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('las dos vistas del registro lo parten sin perder ni duplicar métricas', () => {
    expect([...CRM_MONTHLY_COMPARED_METRICS, ...CRM_MONTHLY_INFO_METRICS].map((m) => m.key).sort())
      .toEqual([...CRM_MONTHLY_METRIC_KEYS].sort());
    expect(CRM_MONTHLY_INFO_METRICS.length).toBeGreaterThan(0);
  });

  it('cada métrica informativa tiene su spec de conceptos, y al revés', () => {
    expect(WALLET_METRIC_SPECS.map((s) => s.metric).sort())
      .toEqual(CRM_MONTHLY_INFO_METRICS.map((m) => m.key).sort());
    for (const s of WALLET_METRIC_SPECS) {
      // Una spec sin conceptos calcularía siempre cero sin decir nada.
      expect(s.concepts.length).toBeGreaterThan(0);
      for (const c of s.concepts) expect(isUnknownConcept(c)).toBe(false);
      for (const c of s.contrastConcepts ?? []) expect(isUnknownConcept(c)).toBe(false);
    }
  });
});
