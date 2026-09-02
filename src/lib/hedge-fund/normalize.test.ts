import { describe, it, expect } from 'vitest';
import {
  commissionConfigChanged,
  commissionConfigFingerprint,
  normalizeCommissionLevels,
  parseExpectedReturn,
  projectReturn,
  toCommissionConfig,
  toFundRow,
  toInvestmentRow,
  toLedgerRow,
  toMonthlyReturnRow,
} from './normalize';

const CO = '11111111-1111-1111-1111-111111111111';
const AT = '2026-09-02T00:00:00.000Z';

describe('parseExpectedReturn', () => {
  // El formato que trae AP Markets hoy.
  it('parsea el rango con guion normal y símbolo', () => {
    expect(parseExpectedReturn('22-26%')).toEqual({ minPct: 22, maxPct: 26 });
  });

  // El CRM lo escribe a mano: los guiones "bonitos" ya aparecen en textos
  // pegados desde un documento.
  it('acepta guion largo y raya', () => {
    expect(parseExpectedReturn('8–12%')).toEqual({ minPct: 8, maxPct: 12 });
    expect(parseExpectedReturn('8—12 %')).toEqual({ minPct: 8, maxPct: 12 });
  });

  it('un solo número es un porcentaje, con o sin símbolo', () => {
    expect(parseExpectedReturn('12')).toEqual({ minPct: 12, maxPct: 12 });
    expect(parseExpectedReturn('12%')).toEqual({ minPct: 12, maxPct: 12 });
  });

  it('sin símbolo el rango sigue siendo porcentaje', () => {
    expect(parseExpectedReturn('2-3')).toEqual({ minPct: 2, maxPct: 3 });
  });

  it('acepta la coma decimal sin partir el número en dos', () => {
    expect(parseExpectedReturn('22,5%')).toEqual({ minPct: 22.5, maxPct: 22.5 });
  });

  // ── La mitad negativa: lo que NO se adivina ──────────────────────────────
  // `null` y nunca 0. Un 0 diría «este fondo no rinde», que es una afirmación
  // que el texto no hizo.
  it('devuelve null —no 0— cuando no hay número', () => {
    for (const raw of ['', '   ', 'a definir', 'variable', null, undefined, {}]) {
      expect(parseExpectedReturn(raw), String(raw)).toBeNull();
    }
  });

  it('devuelve null cuando hay tres o más números (ambiguo)', () => {
    expect(parseExpectedReturn('10-12-15')).toBeNull();
  });

  it('devuelve null cuando el mínimo supera al máximo (texto mal escrito)', () => {
    // Ordenarlo en silencio escondería el error en el CRM.
    expect(parseExpectedReturn('26-22%')).toBeNull();
  });
});

describe('projectReturn', () => {
  it('prorratea el retorno anual por la permanencia', () => {
    // 10.000 al 22-26% anual, 6 meses → la mitad del año.
    expect(projectReturn(10_000, { minPct: 22, maxPct: 26 }, 6)).toEqual({ min: 1100, max: 1300 });
  });

  it('con 12 meses da el porcentaje entero', () => {
    expect(projectReturn(1_000, { minPct: 12, maxPct: 12 }, 12)).toEqual({ min: 120, max: 120 });
  });

  it('es SIMPLE y no compuesto: 24 meses duplican, no capitalizan', () => {
    // Componer daría 210 (1,1² − 1). Se elige la lectura conservadora: de las
    // dos posibles, la que no promete de más.
    expect(projectReturn(1_000, { minPct: 10, maxPct: 10 }, 24)).toEqual({ min: 200, max: 200 });
  });

  it('devuelve null —no ceros— cuando falta cualquier insumo', () => {
    expect(projectReturn(1_000, null, 12)).toBeNull();
    expect(projectReturn(null, { minPct: 10, maxPct: 10 }, 12)).toBeNull();
    expect(projectReturn(1_000, { minPct: 10, maxPct: 10 }, null)).toBeNull();
    expect(projectReturn(1_000, { minPct: 10, maxPct: 10 }, 0)).toBeNull();
  });
});

describe('el vigilante de la configuración de comisiones', () => {
  const cfg = (over: Record<string, unknown> = {}) => ({
    directLevels: [{ level: 1, percent: 5 }, { level: 2, percent: 3 }],
    recurringLevels: [{ level: 1, percent: 1, months: 12 }],
    maxLevels: 3,
    updatedAt: '2026-09-01T10:00:00.000Z',
    updatedBy: 'kevin',
    ...over,
  });

  it('ordena los niveles: reordenar el array no es un cambio', () => {
    const a = toCommissionConfig(cfg());
    const b = toCommissionConfig(cfg({
      directLevels: [{ level: 2, percent: 3 }, { level: 1, percent: 5 }],
    }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(commissionConfigChanged(a, b)).toBe(false);
  });

  it('guardar la pantalla sin tocar nada NO dispara el aviso', () => {
    // `updatedAt` y `updatedBy` se mueven; los porcentajes no.
    const antes = toCommissionConfig(cfg());
    const despues = toCommissionConfig(cfg({
      updatedAt: '2026-09-02T18:00:00.000Z',
      updatedBy: 'otro',
    }));
    expect(commissionConfigChanged(antes, despues)).toBe(false);
  });

  it('un porcentaje distinto SÍ es un cambio', () => {
    const antes = toCommissionConfig(cfg());
    const despues = toCommissionConfig(cfg({
      directLevels: [{ level: 1, percent: 7 }, { level: 2, percent: 3 }],
    }));
    expect(commissionConfigChanged(antes, despues)).toBe(true);
  });

  // El caso de AP Markets: 0/0/0 es un valor legítimo y elegido (Kevin,
  // 2026-09-02). Volver a 5% tiene que verse.
  it('salir de 0/0/0 es un cambio', () => {
    const cero = toCommissionConfig(cfg({
      directLevels: [{ level: 1, percent: 0 }],
      recurringLevels: [{ level: 1, percent: 0, months: 0 }],
      maxLevels: 0,
    }));
    const vuelta = toCommissionConfig(cfg({
      directLevels: [{ level: 1, percent: 5 }],
      recurringLevels: [{ level: 1, percent: 0, months: 0 }],
      maxLevels: 0,
    }));
    expect(commissionConfigChanged(cero, vuelta)).toBe(true);
  });

  it('bajar maxLevels es un cambio aunque ningún porcentaje se mueva', () => {
    // Apaga niveles enteros de pago sin tocar un solo %.
    const antes = toCommissionConfig(cfg({ maxLevels: 5 }));
    const despues = toCommissionConfig(cfg({ maxLevels: 3 }));
    expect(commissionConfigChanged(antes, despues)).toBe(true);
  });

  it('la primera vez (sin snapshot previo) cuenta como cambio', () => {
    expect(commissionConfigChanged(null, toCommissionConfig(cfg()))).toBe(true);
  });

  it('descarta niveles sin level o sin percent en vez de meterlos en cero', () => {
    // Meterlos con 0 diría «este nivel no paga», que el documento no dijo.
    expect(normalizeCommissionLevels([
      { level: 1, percent: 5 },
      { level: 2 },
      { percent: 9 },
      null,
      'ruido',
    ])).toEqual([{ level: 1, percent: 5, months: null }]);
  });

  it('el fingerprint distingue directos de recurrentes', () => {
    const a = commissionConfigFingerprint({
      directLevels: [{ level: 1, percent: 5, months: null }],
      recurringLevels: [],
      maxLevels: 1,
    });
    const b = commissionConfigFingerprint({
      directLevels: [],
      recurringLevels: [{ level: 1, percent: 5, months: null }],
      maxLevels: 1,
    });
    expect(a).not.toBe(b);
  });
});

describe('mapeo de documentos a filas', () => {
  it('el fondo guarda el texto crudo Y el rango parseado', () => {
    const row = toFundRow(
      { fundKey: 'growth', name: 'Growth', expectedReturn: '22-26%', holdingMonths: 12, enabled: false },
      CO, AT,
    );
    expect(row?.expected_return_raw).toBe('22-26%');
    expect(row?.expected_return_min_pct).toBe(22);
    expect(row?.expected_return_max_pct).toBe(26);
    // `enabled=false` se guarda como false, no se descarta: los cinco fondos de
    // Vex Pro están así y la empresa SÍ ofrece el producto.
    expect(row?.enabled).toBe(false);
  });

  it('un retorno no parseable deja las columnas en null, no en 0', () => {
    const row = toFundRow({ fundKey: 'x', expectedReturn: 'a definir' }, CO, AT);
    expect(row?.expected_return_raw).toBe('a definir');
    expect(row?.expected_return_min_pct).toBeNull();
    expect(row?.expected_return_max_pct).toBeNull();
  });

  it('sin llave natural devuelve null: una fila sin PK no se puede re-sincronizar', () => {
    expect(toFundRow({ name: 'sin fundKey' }, CO, AT)).toBeNull();
    expect(toInvestmentRow({ ref: '#HF-1' }, CO, AT)).toBeNull();
    expect(toMonthlyReturnRow({ fundKey: 'growth' }, CO, AT)).toBeNull();
    expect(toMonthlyReturnRow({ ym: '2026-09' }, CO, AT)).toBeNull();
  });

  it('el importe del libro conserva el SIGNO', () => {
    // Una terminación resta y tiene que restar: nada de Math.abs.
    const row = toLedgerRow({ entryId: 'e1', type: 'TERMINATION', amount: -5000 }, CO, AT);
    expect(row?.amount).toBe(-5000);
  });

  it('la inversión cae a `_id` cuando no viene investmentId', () => {
    expect(toInvestmentRow({ _id: 'abc', ref: '#HF-1' }, CO, AT)?.investment_id).toBe('abc');
  });

  it('`ym` null en una comisión directa no es un hueco', () => {
    const row = toMonthlyReturnRow({ fundKey: 'g', ym: '2026-09' }, CO, AT);
    // percent/amount ausentes → null, nunca 0: la pantalla dice «sin datos».
    expect(row?.percent).toBeNull();
    expect(row?.amount).toBeNull();
  });
});
