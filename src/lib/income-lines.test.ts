import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeIncomeTotals,
  computeIncomePending,
  validateIncomeLine,
  groupByClient,
  type IncomeLine,
} from './income-lines';

let seq = 0;
function line(partial: Partial<IncomeLine>): IncomeLine {
  seq += 1;
  return {
    id: `l${seq}`, company_id: 'c1', period_id: 'p1',
    concept: 'Servicio', client: null,
    amount: 100, received: 100, pending: 0,
    category: null, reference: null, income_date: null, sort_order: seq,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

describe('computeIncomeTotals', () => {
  // Números reales de Ene 26 de la contabilidad de Horizon: facturó 23.000,
  // cobró 13.500 y quedaron 9.500 por cobrar.
  it('separa facturado de cobrado', () => {
    const t = computeIncomeTotals([
      line({ amount: 10_000, received: 10_000, pending: 0 }),
      line({ amount: 6_000, received: 0, pending: 6_000 }),
      line({ amount: 2_500, received: 2_500, pending: 0 }),
      line({ amount: 2_500, received: 0, pending: 2_500 }),
      line({ amount: 2_000, received: 1_000, pending: 1_000 }),
    ]);
    expect(t.amount).toBe(23_000);
    expect(t.received).toBe(13_500);
    expect(t.pending).toBe(9_500);
  });

  it('no arrastra error de coma flotante', () => {
    const t = computeIncomeTotals([
      line({ amount: 0.1, received: 0.1, pending: 0 }),
      line({ amount: 0.2, received: 0.2, pending: 0 }),
    ]);
    expect(t.amount).toBe(0.3);
  });

  it('una lista vacía da todo en cero', () => {
    expect(computeIncomeTotals([])).toEqual({ amount: 0, received: 0, pending: 0 });
  });
});

describe('computeIncomePending', () => {
  it('deriva pendiente = facturado − cobrado', () => {
    expect(computeIncomePending(2000, 1000)).toBe(1000);
    expect(computeIncomePending('2500', '0', '')).toBe(2500);
  });

  it('respeta un pendiente explícito mayor que cero', () => {
    expect(computeIncomePending(2000, 1000, 800)).toBe(800);
  });

  it('cobrado igual al facturado deja pendiente en cero', () => {
    expect(computeIncomePending(1090, 1090)).toBe(0);
  });
});

describe('validateIncomeLine', () => {
  const ok = { concept: 'Vex Pro CRM', amount: 10_000, received: 10_000 };

  it('acepta una línea bien formada', () => {
    expect(validateIncomeLine(ok)).toBeNull();
  });

  it('acepta facturado sin cobrar', () => {
    expect(validateIncomeLine({ ...ok, received: 0 })).toBeNull();
  });

  it('rechaza concepto vacío y monto no numérico', () => {
    expect(validateIncomeLine({ ...ok, concept: '  ' })).toMatch(/concepto/i);
    expect(validateIncomeLine({ ...ok, amount: NaN })).toMatch(/monto/i);
  });

  // Lo cobrado es lo que la cadena reparte: cobrar de más descuadra la
  // distribución sin que nada más lo delate.
  it('rechaza cobrar más de lo facturado', () => {
    expect(validateIncomeLine({ ...ok, received: 10_001 })).toMatch(/superar/i);
  });

  it('tolera un centavo de diferencia por redondeo', () => {
    expect(validateIncomeLine({ ...ok, received: 10_000.01 })).toBeNull();
  });
});

describe('groupByClient', () => {
  it('agrupa y ordena por facturación descendente', () => {
    const g = groupByClient([
      line({ client: 'Be Prime', amount: 6_000, received: 6_000 }),
      line({ client: 'Vex Pro', amount: 10_000, received: 10_000 }),
      line({ client: 'Vex Pro', amount: 2_500, received: 0, pending: 2_500 }),
    ]);
    expect(g[0].client).toBe('Vex Pro');
    expect(g[0].totals.amount).toBe(12_500);
    expect(g[0].totals.pending).toBe(2_500);
    expect(g[1].client).toBe('Be Prime');
  });

  it('junta las líneas sin cliente bajo una sola etiqueta', () => {
    const g = groupByClient([line({ client: null }), line({ client: '   ' })]);
    expect(g).toHaveLength(1);
    expect(g[0].client).toBe('Sin asignar');
  });
});

// ── Pendiente: la regla que faltaba (auditoría 2026-08, B6) ────────────────
// `pending` se persistía y se sumaba en las cuentas por cobrar sin ninguna
// validación: un tipeo lo inflaba y nada lo señalaba.
describe('validateIncomeLine — pendiente', () => {
  it('acepta el pendiente derivado de facturado − cobrado', () => {
    expect(validateIncomeLine({ concept: 'X', amount: 1_000, received: 400, pending: 600 }))
      .toBeNull();
  });

  it('acepta el pendiente omitido', () => {
    expect(validateIncomeLine({ concept: 'X', amount: 1_000, received: 1_000 })).toBeNull();
  });

  it('rechaza un pendiente negativo', () => {
    expect(validateIncomeLine({ concept: 'X', amount: 1_000, received: 0, pending: -1 }))
      .toMatch(/pendiente no puede ser negativo/);
  });

  it('rechaza un pendiente mayor que lo que falta cobrar', () => {
    expect(validateIncomeLine({ concept: 'X', amount: 1_000, received: 400, pending: 6_000 }))
      .toMatch(/pendiente no puede superar/);
  });

  it('tolera un centavo de redondeo', () => {
    expect(validateIncomeLine({ concept: 'X', amount: 100, received: 33.33, pending: 66.67 }))
      .toBeNull();
  });

  it('rechaza un pendiente no numérico', () => {
    expect(validateIncomeLine({
      concept: 'X', amount: 100, received: 0, pending: Number.NaN,
    })).toMatch(/pendiente no es un número/);
  });
});

// ── Migración 073: la RPC no puede volver a pisar el "otros ingresos" manual ─
// (auditoría 2026-08, A4). La lógica vive en SQL, así que lo que se fija acá
// es el contrato del archivo: que exista la rama de preservación, que sea
// condicional a "el período NO tenía líneas" y que no se haya perdido la
// materialización del total. Un CREATE OR REPLACE que se olvide de cualquiera
// de las tres cosas vuelve a borrar plata.
describe('migración 073 — preserva el other manual', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migration-073-preserve-manual-other.sql'),
    'utf8',
  );

  it('reemplaza la RPC de la 068', () => {
    expect(sql).toMatch(/create or replace function public\.replace_income_lines/);
  });

  it('lee el estado previo ANTES del delete', () => {
    const readIdx = sql.indexOf('into v_had_lines');
    const deleteIdx = sql.indexOf('delete from public.income_lines');
    expect(readIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(readIdx);
  });

  it('preserva solo cuando no había líneas y el other manual es positivo', () => {
    expect(sql).toMatch(/if not v_had_lines and coalesce\(v_manual_other, 0\) > 0 then/);
    expect(sql).toContain('Otros ingresos (histórico)');
    expect(sql).toMatch(/-1\s*\n?\s*\);/);
  });

  it('sigue materializando lo COBRADO en operating_income.other', () => {
    expect(sql).toMatch(/select coalesce\(sum\(received\), 0\) into v_received/);
    expect(sql).toMatch(/do update set other = excluded\.other/);
  });
});
