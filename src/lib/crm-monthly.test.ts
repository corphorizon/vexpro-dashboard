import { describe, it, expect } from 'vitest';
import { HEDGE_FUND_CONCEPTS, isUnknownConcept } from './crm-wallet-concepts';
import {
  CRM_MONTHLY_METRICS,
  CRM_MONTHLY_METRIC_KEYS,
  CRM_MONTHLY_COMPARED_METRICS,
  CRM_MONTHLY_INFO_METRICS,
  WALLET_METRIC_CONCEPTS,
  WALLET_METRIC_SPECS,
  aggregateWalletMetricByMonth,
  aggregateFairpayAdjustmentByMonth,
  type FairpayPayment,
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

  it('cada spec de conceptos es una métrica informativa del registro', () => {
    // La igualdad al revés dejó de valer con el ajuste FairPay (2026-08-31):
    // es informativa pero NO sale de `wallettransfers` —los dos lados de su
    // cruce viven en Postgres—, así que no tiene spec de conceptos. Lo que sí
    // sigue siendo cierto es que ninguna spec puede apuntar a una métrica que
    // el registro no declara: eso escribiría filas que la pantalla no muestra.
    const info = CRM_MONTHLY_INFO_METRICS.map((m) => m.key);
    for (const s of WALLET_METRIC_SPECS) expect(info).toContain(s.metric);
    // Y las que no vienen de la billetera se nombran acá, para que agregar una
    // sea una decisión y no un olvido.
    expect(info.filter((k) => !WALLET_METRIC_SPECS.some((s) => s.metric === k))).toEqual([
      'fairpay_adjustment',
    ]);
    for (const s of WALLET_METRIC_SPECS) {
      // Una spec sin conceptos calcularía siempre cero sin decir nada.
      expect(s.concepts.length).toBeGreaterThan(0);
      for (const c of s.concepts) expect(isUnknownConcept(c)).toBe(false);
      for (const c of s.contrastConcepts ?? []) expect(isUnknownConcept(c)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HEDGE FUND — la cuarta serie informativa (Kevin, 2026-08-31).
//
// Los números de acá NO son inventados: salen del censo concepto × dirección
// que se corrió contra los `wallettransfers` reales el 2026-08-31.
//   AP Markets: INVEST OUT 22 mov. $23.928,88 · REWARD IN 23 mov. $927,10
//               (gross $24.560) · REWARD OUT 3 mov. $926,00 · RETURN IN 3
//               mov. $302,00.
//   Vex Pro:    INVEST OUT 1 mov. $3.000,00 y nada más.
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_SPEC = WALLET_METRIC_SPECS.find((s) => s.metric === 'hedge_fund')!;

describe('hedge_fund', () => {
  it('el total de la serie es el CAPITAL INVERTIDO (la pata OUT)', () => {
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'HEDGE_FUND_INVEST', direction: 'OUT', net: 23928.88, count: 22 })],
      HEDGE_SPEC,
    );
    const b = r.buckets.get('2026-07')!;
    expect(b.amount).toBe(23928.88);
    expect(b.count).toBe(22);
  });

  it('rendimientos, reversos de rendimiento y capital devuelto van CADA UNO a su columna', () => {
    // Netearlos daría 23.928,88 − 927,10 − 302 = 22.699,78: un número
    // plausible que no responde ni "cuánto hay colocado" ni "cuánto rindió".
    const r = aggregateWalletMetricByMonth(
      [
        fila({ concept: 'HEDGE_FUND_INVEST', direction: 'OUT', net: 23928.88, count: 22 }),
        fila({ concept: 'HEDGE_FUND_REWARD', direction: 'IN', net: 927.1, gross: 24560, count: 23 }),
        fila({ concept: 'HEDGE_FUND_REWARD', direction: 'OUT', net: 926, count: 3 }),
        fila({ concept: 'HEDGE_FUND_RETURN', direction: 'IN', net: 302, count: 3 }),
      ],
      HEDGE_SPEC,
    );
    const b = r.buckets.get('2026-07')!;
    expect(b.amount).toBe(23928.88);
    expect(b.cross.rewards).toBe(927.1);
    expect(b.cross.rewardsCount).toBe(23);
    expect(b.cross.rewardsReversed).toBe(926);
    expect(b.cross.capitalReturned).toBe(302);
    // El bruto del reward es el CAPITAL sobre el que se calculó, no dinero
    // acreditado: no puede colarse a ninguna columna de importe.
    expect(b.cross.gross).toBe(0);
    expect(r.unclassified.size).toBe(0);
  });

  it('una empresa con sólo INVEST muestra las hermanas en CERO, no en "—"', () => {
    // Vex Pro: se leyó la familia entera y no hubo un solo reward. Eso ES
    // cero, no "no lo sabemos".
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'HEDGE_FUND_INVEST', direction: 'OUT', net: 3000, monthKey: '2026-06' })],
      HEDGE_SPEC,
    );
    const b = r.buckets.get('2026-06')!;
    expect(b.amount).toBe(3000);
    expect(b.cross.rewards).toBe(0);
    expect(b.cross.capitalReturned).toBe(0);
  });

  it('una dirección que ninguna entrada declara NO se traga: se cuenta y se avisa', () => {
    // El día que aparezca un HEDGE_FUND_RETURN OUT (¿un rescate revertido?)
    // tiene que verse, no desaparecer de la serie.
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'HEDGE_FUND_RETURN', direction: 'OUT', net: 77, count: 2 })],
      HEDGE_SPEC,
    );
    expect(r.buckets.size).toBe(0);
    expect(r.unclassified.get('HEDGE_FUND_RETURN')).toEqual({ count: 2, amount: 77 });
  });

  it('una hermana sin mes utilizable no se inventa un mes', () => {
    const r = aggregateWalletMetricByMonth(
      [fila({ concept: 'HEDGE_FUND_REWARD', direction: 'IN', monthKey: null, net: 12, count: 1 })],
      HEDGE_SPEC,
    );
    expect(r.buckets.size).toBe(0);
    expect(r.noMonth).toEqual({ count: 1, amount: 12 });
  });

  it('está en las informativas y NO en las comparadas contra lo manual', () => {
    expect(CRM_MONTHLY_INFO_METRICS.map((m) => m.key)).toContain('hedge_fund');
    expect(CRM_MONTHLY_COMPARED_METRICS.map((m) => m.key)).not.toContain('hedge_fund');
  });

  it('sus tres conceptos entran en la proyección que se le pide a Mongo', () => {
    // Si uno faltara acá, el $match no lo traería y la columna daría 0 sin
    // que nada avise: el fallo silencioso de siempre.
    for (const c of Object.values(HEDGE_FUND_CONCEPTS)) {
      expect(WALLET_METRIC_CONCEPTS).toContain(c);
      expect(isUnknownConcept(c)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AJUSTE FAIRPAY — el recargo cobrado y no acreditado.
//
// Los números son los REALES de producción (medidos el 2026-08-31), así que si
// alguien cambia la llave del cruce o el trato de lo que no cruza, el test dice
// exactamente qué plata se mueve.
// ─────────────────────────────────────────────────────────────────────────────

describe('ajuste FairPay', () => {
  const pago = (p: Partial<FairpayPayment>): FairpayPayment => ({
    paidAt: '2026-07-15T10:00:00.000Z',
    gross: 104,
    crossed: true,
    credited: 100,
    creditedInCrm: true,
    ...p,
  });

  it('el ajuste es bruto menos acreditado, pago por pago', () => {
    const { buckets } = aggregateFairpayAdjustmentByMonth([
      pago({ gross: 104, credited: 100 }),
      pago({ gross: 52, credited: 50 }),
    ]);
    const b = buckets.get('2026-07')!;
    expect(b.amount).toBe(6);
    expect(b.count).toBe(2);
    expect(b.cross.gross).toBe(156);
    expect(b.cross.credited).toBe(150);
  });

  it('un pago SIN contraparte en el CRM no entra al ajuste: se excluye y se cuenta', () => {
    // Las 24 filas de junio 2026 por $4.383,00. Contarlas enteras como recargo
    // sería inventar $4.383 de costo; tirarlas sin avisar sería peor.
    const { buckets } = aggregateFairpayAdjustmentByMonth([
      pago({ paidAt: '2026-06-10T00:00:00.000Z', gross: 104, credited: 100 }),
      pago({ paidAt: '2026-06-11T00:00:00.000Z', gross: 4383, crossed: false, credited: null }),
    ]);
    const b = buckets.get('2026-06')!;
    expect(b.amount).toBe(4);
    expect(b.count).toBe(1);
    expect(b.excludedCount).toBe(1);
    expect(b.excludedAmount).toBe(4383);
  });

  it('un cruce sin importe acreditado tampoco entra: null no es 0', () => {
    const { buckets } = aggregateFairpayAdjustmentByMonth([
      pago({ gross: 104, crossed: true, credited: null }),
    ]);
    const b = buckets.get('2026-07')!;
    expect(b.amount).toBe(0);
    expect(b.count).toBe(0);
    expect(b.excludedCount).toBe(1);
    expect(b.excludedAmount).toBe(104);
  });

  it('el pago cancelado en el CRM suma al ajuste pero queda VISIBLE aparte', () => {
    // 0d039080… del 2026-08-07: bruto 93,60 y amount_paid 0. No es recargo, es
    // un depósito cancelado entero. Entra al total (así cierra contra los
    // $2.994,83 ya cargados) y se informa en `notCredited`.
    const { buckets } = aggregateFairpayAdjustmentByMonth([
      pago({ paidAt: '2026-08-07T03:26:45.000Z', gross: 93.6, credited: 0, creditedInCrm: false }),
      pago({ paidAt: '2026-08-08T00:00:00.000Z', gross: 104, credited: 100 }),
    ]);
    const b = buckets.get('2026-08')!;
    expect(b.amount).toBe(97.6);
    expect(b.cross.notCredited).toBe(93.6);
    expect(b.cross.notCreditedCount).toBe(1);
  });

  it('un mes sin recargo da 0, que es un cero MEDIDO (y sí escribe fila)', () => {
    const { buckets } = aggregateFairpayAdjustmentByMonth([pago({ gross: 100, credited: 100 })]);
    expect(buckets.get('2026-07')!.amount).toBe(0);
    expect(buckets.size).toBe(1);
  });

  it('un mes sin pagos NO existe: "sin datos" no es "$0"', () => {
    expect(aggregateFairpayAdjustmentByMonth([]).buckets.size).toBe(0);
  });

  it('un ajuste negativo NO se recorta a 0: es un hallazgo, no un cero', () => {
    const { buckets } = aggregateFairpayAdjustmentByMonth([pago({ gross: 100, credited: 110 })]);
    expect(buckets.get('2026-07')!.amount).toBe(-10);
  });

  it('un pago sin fecha utilizable no se inventa un mes', () => {
    const { buckets, noMonth } = aggregateFairpayAdjustmentByMonth([
      pago({ paidAt: null, gross: 104 }),
    ]);
    expect(buckets.size).toBe(0);
    expect(noMonth).toEqual({ count: 1, amount: 104 });
  });

  it('el mes sale en UTC, no en la zona del proceso (G4)', () => {
    // 2026-08-01T00:30Z es agosto. En Buenos Aires sería el 31 de julio.
    const { buckets } = aggregateFairpayAdjustmentByMonth([
      pago({ paidAt: '2026-08-01T00:30:00.000Z' }),
    ]);
    expect([...buckets.keys()]).toEqual(['2026-08']);
  });

  it('la serie completa de Vex Pro reproduce los $2.994,83 ya cargados', () => {
    // abr 168,31 · may 381,01 · jun 752,75 · jul 1.260,71 · ago 432,05.
    const meses: Array<[string, number, number]> = [
      ['2026-04', 4313.72, 4145.41],
      ['2026-05', 9547.0, 9165.99],
      ['2026-06', 16438.0, 15685.25],
      ['2026-07', 29089.68, 27828.97],
      ['2026-08', 6479.2, 6047.15],
    ];
    const { buckets } = aggregateFairpayAdjustmentByMonth(
      meses.map(([mes, bruto, neto]) =>
        pago({ paidAt: `${mes}-15T00:00:00.000Z`, gross: bruto, credited: neto }),
      ),
    );
    expect(buckets.get('2026-04')!.amount).toBeCloseTo(168.31, 2);
    expect(buckets.get('2026-05')!.amount).toBeCloseTo(381.01, 2);
    expect(buckets.get('2026-06')!.amount).toBeCloseTo(752.75, 2);
    expect(buckets.get('2026-07')!.amount).toBeCloseTo(1260.71, 2);
    expect(buckets.get('2026-08')!.amount).toBeCloseTo(432.05, 2);
    const total = [...buckets.values()].reduce((s, b) => s + b.amount, 0);
    expect(total).toBeCloseTo(2994.83, 2);
  });

  it('está en las informativas y NO en las comparadas contra lo manual', () => {
    expect(CRM_MONTHLY_INFO_METRICS.map((m) => m.key)).toContain('fairpay_adjustment');
    expect(CRM_MONTHLY_COMPARED_METRICS.map((m) => m.key)).not.toContain('fairpay_adjustment');
    expect(CRM_MONTHLY_METRIC_KEYS).toContain('fairpay_adjustment');
  });

  it('las columnas del detalle que declara la métrica son las que el cálculo llena', () => {
    // Si alguien renombra una clave del `cross` sin tocar el registro, la
    // pantalla mostraría "—" para siempre y nadie se enteraría.
    const def = CRM_MONTHLY_METRICS.find((m) => m.key === 'fairpay_adjustment')!;
    const { buckets } = aggregateFairpayAdjustmentByMonth([pago({})]);
    const cross = buckets.get('2026-07')!.cross;
    for (const c of def.detailColumns ?? []) {
      expect(Object.keys(cross)).toContain(c.key);
    }
  });
});
