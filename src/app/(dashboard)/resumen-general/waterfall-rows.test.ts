// La cascada de /resumen-general: mismas filas que el PDF de cierre
// (buildCloseWaterfall), con clave, signo y fila de total.
import { describe, it, expect } from 'vitest';
import { buildCloseWaterfall } from '@/lib/monthly-close-pdf-data';
import {
  expenseBasisGap,
  expenseCategoryRows,
  waterfallForPeriod,
  waterfallForRange,
  waterfallKey,
  waterfallMismatches,
  waterfallTableRows,
  type WaterfallChainEntry,
} from './waterfall-rows';

// Vex Pro, sep-2026 (los números del incidente del 2026-10-05).
const SEP26: WaterfallChainEntry = {
  desglose: { brokerPnl: 226_605.2, propFirmNetIncome: 13_248.27, investmentProfits: 23_616.52, other: 0 },
  ingresosNetos: 263_469.99,
  egresosNetos: 208_084.45,
  saldoAFavor: 55_385.54,
  reserveThisPeriod: 5_038.55,
  deudaArrastradaEntrada: 5_000,
  montoDistribuir: 45_346.99,
  incompleto: [],
  incompletoEstado: null,
  heredaIncompleto: false,
};

describe('waterfallKey — rótulo del PDF → clave', () => {
  it('cada renglón que imprime el PDF tiene clave (ninguno cae en unknown)', () => {
    const { result } = waterfallForPeriod({ ...SEP26, desglose: { ...SEP26.desglose, other: 10 } }, 0.1);
    const keys = result.rows.map((r) => waterfallKey(r.label));
    expect(keys).not.toContain('unknown');
    expect(keys).toEqual([
      'brokerPnl',
      'propFirm',
      'investments',
      'other',
      'ingresos',
      'egresos',
      'resultado',
      'deuda',
      'reserva',
      'distribuir',
    ]);
  });

  it('«Otros ingresos» con rótulo propio (facturación cobrada) se reconoce', () => {
    expect(waterfallKey('Facturación cobrada', 'Facturación cobrada')).toBe('other');
    expect(waterfallKey('Facturación cobrada')).toBe('unknown');
    expect(waterfallKey('Reserva del mes (10%)')).toBe('reserva');
    expect(waterfallKey('Algo nuevo')).toBe('unknown');
  });
});

describe('waterfallForPeriod — las filas del PDF, con signo', () => {
  it('son exactamente las filas de buildCloseWaterfall (mismos montos, mismo orden)', () => {
    const { rows } = waterfallForPeriod(SEP26, 0.1);
    const pdf = buildCloseWaterfall({
      desglose: SEP26.desglose,
      ingresosNetos: SEP26.ingresosNetos,
      egresos: SEP26.egresosNetos,
      saldo: SEP26.saldoAFavor,
      reservaMes: SEP26.reserveThisPeriod,
      reservePct: 0.1,
      deudaEntrada: SEP26.deudaArrastradaEntrada,
      montoDistribuir: SEP26.montoDistribuir,
    });
    expect(rows.map((r) => [r.pdfLabel, r.amount])).toEqual(pdf.rows.map((r) => [r.label, r.amount]));
  });

  it('+ para ingresos, − para egresos/deuda/reserva, = para totales (filas group-row)', () => {
    const { rows } = waterfallForPeriod(SEP26, 0.1);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.brokerPnl).toMatchObject({ op: '+', isTotal: false, amount: 226_605.2 });
    expect(by.egresos).toMatchObject({ op: '−', isTotal: false, amount: -208_084.45 });
    expect(by.deuda).toMatchObject({ op: '−', amount: -5_000 });
    expect(by.reserva).toMatchObject({ op: '−', amount: -5_038.55 });
    expect(by.ingresos).toMatchObject({ op: '=', isTotal: true });
    expect(by.resultado).toMatchObject({ op: '=', isTotal: true, signTone: true });
    expect(by.distribuir).toMatchObject({ op: '=', isTotal: true, signTone: false, amount: 45_346.99 });
    // Renglón de detalle en cero (other) no se imprime; los totales siempre.
    expect(by.other).toBeUndefined();
  });

  it('cuadra: sin diferencias', () => {
    const { result } = waterfallForPeriod(SEP26, 0.1);
    expect(waterfallMismatches(result)).toEqual([]);
  });

  it('serie del CRM faltante: Broker P&L y los totales sin número (null), nunca 0; sin control de cuadre', () => {
    const { rows, result } = waterfallForPeriod(
      {
        ...SEP26,
        desglose: { ...SEP26.desglose, brokerPnl: null },
        incompleto: ['brokerPnl'],
        incompletoEstado: 'loading',
      },
      0.1,
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.brokerPnl.amount).toBeNull();
    expect(by.ingresos.amount).toBeNull();
    expect(by.resultado.amount).toBeNull();
    expect(by.distribuir.amount).toBeNull();
    // Los egresos no dependen del CRM: se saben.
    expect(by.egresos.amount).toBe(-208_084.45);
    expect(waterfallMismatches(result)).toEqual([]);
  });

  it('sin reserve_pct usa el 10 % por defecto, como el PDF de /socios', () => {
    const { rows } = waterfallForPeriod(SEP26, null);
    expect(rows.find((r) => r.key === 'reserva')?.pdfLabel).toBe('Reserva del mes (10%)');
  });
});

describe('waterfallMismatches — control de cuadre → Notice bad', () => {
  it('ingresos que no explican el total', () => {
    const { result } = waterfallForPeriod({ ...SEP26, ingresosNetos: SEP26.ingresosNetos + 100 }, 0.1);
    expect(waterfallMismatches(result)).toContainEqual({ key: 'ingresos', amount: -100 });
  });

  it('distribución que no cierra', () => {
    const { result } = waterfallForPeriod({ ...SEP26, montoDistribuir: SEP26.montoDistribuir - 50 }, 0.1);
    expect(waterfallMismatches(result)).toEqual([{ key: 'distribucion', amount: 50 }]);
  });

  it('un centavo de tolerancia no es una diferencia', () => {
    const { result } = waterfallForPeriod({ ...SEP26, montoDistribuir: SEP26.montoDistribuir + 0.01 }, 0.1);
    expect(waterfallMismatches(result)).toEqual([]);
  });
});

describe('waterfallForRange — consolidado: sólo lo que se suma entre meses', () => {
  const OCT = { ...SEP26, desglose: { ...SEP26.desglose, brokerPnl: 1000 }, ingresosNetos: 37_864.79, egresosNetos: 10_000, saldoAFavor: 27_864.79 };

  it('corta en Resultado (sin deuda / reserva / a distribuir) y suma los componentes', () => {
    const { rows, result } = waterfallForRange([SEP26, OCT]);
    expect(rows.map((r) => r.key)).toEqual(['brokerPnl', 'propFirm', 'investments', 'ingresos', 'egresos', 'resultado']);
    expect(rows.find((r) => r.key === 'brokerPnl')?.amount).toBe(227_605.2);
    expect(rows.find((r) => r.key === 'resultado')?.amount).toBe(83_250.33);
    expect(waterfallMismatches(result)).toEqual([]);
    expect(result.deudaQuePasa).toBe(0);
  });

  it('un mes sin la serie: el sumando del conjunto es null (no la suma de los que llegaron)', () => {
    const { rows } = waterfallForRange([
      SEP26,
      { ...OCT, desglose: { ...OCT.desglose, brokerPnl: null }, incompleto: ['brokerPnl'], incompletoEstado: 'failed' },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.brokerPnl.amount).toBeNull();
    expect(by.ingresos.amount).toBeNull();
    expect(by.resultado.amount).toBeNull();
  });

  it('sigue controlando el cuadre de los ingresos', () => {
    const { result } = waterfallForRange([SEP26, { ...OCT, ingresosNetos: OCT.ingresosNetos + 7 }]);
    expect(waterfallMismatches(result)).toEqual([{ key: 'ingresos', amount: -7 }]);
  });
});

describe('waterfallTableRows', () => {
  it('rótulo desconocido → unknown (el test de arriba falla si el PDF renombra un renglón)', () => {
    const rows = waterfallTableRows({
      rows: [{ label: 'Renglón nuevo', amount: 1, kind: 'income' }],
      diferenciaIngresos: null,
      diferenciaDistribucion: null,
      deudaQuePasa: 0,
      warnings: [],
      aviso: null,
      resultadoConocido: true,
      distribucionConocida: true,
    });
    expect(rows[0].key).toBe('unknown');
  });
});

describe('expenseCategoryRows / expenseBasisGap', () => {
  it('% sobre el total; sin categoría → null; total no positivo → % null', () => {
    const rows = expenseCategoryRows(
      [
        { category: 'Sueldos', amount: 750, paid: 750, pending: 0, count: 3 },
        { category: '__uncategorized__', amount: 250, paid: 0, pending: 250, count: 1 },
      ],
      1000,
      '__uncategorized__',
    );
    expect(rows.map((r) => [r.category, r.sharePct])).toEqual([
      ['Sueldos', 75],
      [null, 25],
    ]);
    expect(expenseCategoryRows([{ category: 'X', amount: 0, paid: 0, pending: 0, count: 1 }], 0, '_')[0].sharePct).toBeNull();
  });

  it('la diferencia entre lo cargado y lo que usa el resultado se dice; un centavo no', () => {
    expect(expenseBasisGap(21_928.23, 16_563.23)).toBe(5_365);
    expect(expenseBasisGap(100, 100.01)).toBeNull();
    expect(expenseBasisGap(100, null)).toBeNull();
  });
});
