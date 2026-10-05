import { describe, it, expect } from 'vitest';
import {
  bucketDePnl,
  esLineaNdDeMasterIb,
  filasPnlDe,
  filaPnlVigente,
  planDeBucketPnl,
  type FilaMigrable,
  type PerfilPnl,
} from './pnl-buckets';

// Los ids del incidente del 2026-09-16, con nombres para que el test se lea.
const HECTOR: PerfilPnl = { id: 'hector', head_id: 'hugo', is_master_ib: false };
const JOSE: PerfilPnl = { id: 'jose', head_id: 'ana', is_master_ib: true };

function fila(over: Partial<FilaMigrable> & { id: string; head_id: string | null }): FilaMigrable {
  return { profile_id: HECTOR.id, updated_at: null, ...over };
}

describe('bucketDePnl — la doctrina', () => {
  it('es SIEMPRE el id del perfil, aunque tenga head', () => {
    expect(bucketDePnl(HECTOR)).toBe('hector');
    expect(bucketDePnl(JOSE)).toBe('jose');
  });

  it('no hereda el head ni con head_id nulo', () => {
    expect(bucketDePnl({ id: 'x', head_id: null })).toBe('x');
  });
});

describe('esLineaNdDeMasterIb — la excepción que no se rompe', () => {
  it('la fila de Jose bajo Ana ES su línea ND (no es PnL)', () => {
    expect(esLineaNdDeMasterIb({ profile_id: 'jose', head_id: 'ana' }, JOSE)).toBe(true);
  });

  it('la fila de Jose en su bucket propio NO es la línea ND', () => {
    expect(esLineaNdDeMasterIb({ profile_id: 'jose', head_id: 'jose' }, JOSE)).toBe(false);
  });

  it('la fila de Jose bajo OTRO head (bucket ajeno viejo) NO es la línea ND', () => {
    expect(esLineaNdDeMasterIb({ profile_id: 'jose', head_id: 'luka' }, JOSE)).toBe(false);
  });

  it('sin is_master_ib, la fila bajo su head es PnL duplicado y NO está protegida', () => {
    expect(esLineaNdDeMasterIb({ profile_id: 'hector', head_id: 'hugo' }, HECTOR)).toBe(false);
  });

  it('un master sin head_id no protege nada', () => {
    expect(
      esLineaNdDeMasterIb({ profile_id: 'z', head_id: null }, { id: 'z', head_id: null, is_master_ib: true }),
    ).toBe(false);
  });
});

describe('filasPnlDe', () => {
  it('filtra por perfil y saca la línea ND del master', () => {
    const rows = [
      { profile_id: 'jose', head_id: 'jose' },
      { profile_id: 'jose', head_id: 'ana' }, // línea ND — fuera
      { profile_id: 'jose', head_id: 'luka' }, // bucket ajeno viejo — dentro
      { profile_id: 'otro', head_id: 'jose' }, // otra persona — fuera
    ];
    expect(filasPnlDe(rows, JOSE)).toEqual([
      { profile_id: 'jose', head_id: 'jose' },
      { profile_id: 'jose', head_id: 'luka' },
    ]);
  });
});

describe('filaPnlVigente — lo que se LEE', () => {
  it('prefiere el bucket propio aunque haya filas ajenas', () => {
    const rows = [
      fila({ id: 'vieja', head_id: 'hugo' }),
      fila({ id: 'propia', head_id: 'hector' }),
      fila({ id: 'otra', head_id: 'luka' }),
    ];
    expect(filaPnlVigente(rows, HECTOR)?.id).toBe('propia');
  });

  it('fallback documentado: sin fila propia, sirve una ajena (Millones693 ene/feb/may)', () => {
    const rows = [fila({ id: 'solo-ajena', head_id: 'nicolas' })];
    expect(filaPnlVigente(rows, HECTOR)?.id).toBe('solo-ajena');
  });

  it('para el master NUNCA devuelve su línea ND', () => {
    const rows = [{ profile_id: 'jose', head_id: 'ana', id: 'linea-nd' }];
    expect(filaPnlVigente(rows, JOSE)).toBeNull();
  });

  it('sin filas devuelve null (y no 0: no lo sabemos, §1.3)', () => {
    expect(filaPnlVigente([], HECTOR)).toBeNull();
  });
});

describe('planDeBucketPnl — qué sobrevive a la migración', () => {
  it('EL CASO HECTOR: tres filas de agosto, gana la más reciente (319,77)', () => {
    const rows = [
      fila({ id: 'r-vieja-crm', head_id: 'hugo', updated_at: '2026-08-20T10:00:00Z' }), // 740,61
      fila({ id: 'r-manual-a', head_id: 'luka', updated_at: '2026-09-10T09:00:00Z' }),
      fila({ id: 'r-manual-b', head_id: 'ana', updated_at: '2026-09-12T18:00:00Z' }), // 319,77
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.sinCambios).toBe(false);
    expect(plan.superviviente?.id).toBe('r-manual-b');
    expect(plan.motivo).toBe('updated_at');
    expect(plan.necesitaRehome).toBe(true);
    expect(plan.necesitaCopia).toBe(false);
    expect(plan.queda?.id).toBe('r-manual-b');
    expect(plan.aBorrar.map((r) => r.id)).toEqual(['r-vieja-crm', 'r-manual-a']);
  });

  it('con fila propia Y un superviviente ajeno: se copia sobre la propia y se borra el ajeno', () => {
    const rows = [
      fila({ id: 'propia', head_id: 'hector', updated_at: '2026-08-01T00:00:00Z' }),
      fila({ id: 'ajena-nueva', head_id: 'hugo', updated_at: '2026-09-01T00:00:00Z' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.superviviente?.id).toBe('ajena-nueva');
    expect(plan.queda?.id).toBe('propia');
    expect(plan.necesitaCopia).toBe(true);
    expect(plan.necesitaRehome).toBe(false);
    expect(plan.aBorrar.map((r) => r.id)).toEqual(['ajena-nueva']);
  });

  it('la propia ya es la más reciente: se borran las otras, sin copia ni rehome', () => {
    const rows = [
      fila({ id: 'propia', head_id: 'hector', updated_at: '2026-09-09T00:00:00Z' }),
      fila({ id: 'ajena', head_id: 'hugo', updated_at: '2026-08-01T00:00:00Z' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.necesitaCopia).toBe(false);
    expect(plan.necesitaRehome).toBe(false);
    expect(plan.aBorrar.map((r) => r.id)).toEqual(['ajena']);
  });

  it('una sola fila y ya es la propia → sinCambios', () => {
    const plan = planDeBucketPnl([fila({ id: 'p', head_id: 'hector' })], HECTOR);
    expect(plan.sinCambios).toBe(true);
    expect(plan.motivo).toBe('ya-propia');
    expect(plan.aBorrar).toEqual([]);
  });

  it('una sola fila ajena → se re-homea (NO es sinCambios)', () => {
    const plan = planDeBucketPnl([fila({ id: 'sola', head_id: 'nicolas' })], HECTOR);
    expect(plan.sinCambios).toBe(false);
    expect(plan.necesitaRehome).toBe(true);
    expect(plan.queda?.id).toBe('sola');
    expect(plan.aBorrar).toEqual([]);
  });

  it('sin filas → sinCambios y nada que borrar', () => {
    const plan = planDeBucketPnl([], HECTOR);
    expect(plan.sinCambios).toBe(true);
    expect(plan.motivo).toBe('sin-filas');
    expect(plan.superviviente).toBeNull();
  });

  it('sin updated_at usable gana la propia', () => {
    const rows = [
      fila({ id: 'ajena', head_id: 'hugo', updated_at: null }),
      fila({ id: 'propia', head_id: 'hector', updated_at: 'no-es-una-fecha' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.motivo).toBe('propia-sin-fecha');
    expect(plan.superviviente?.id).toBe('propia');
    expect(plan.advertencia).toBeNull();
    expect(plan.aBorrar.map((r) => r.id)).toEqual(['ajena']);
  });

  it('empate de updated_at: gana la propia, sin advertencia', () => {
    const rows = [
      fila({ id: 'ajena', head_id: 'hugo', updated_at: '2026-09-12T18:00:00Z' }),
      fila({ id: 'propia', head_id: 'hector', updated_at: '2026-09-12T18:00:00Z' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.superviviente?.id).toBe('propia');
    expect(plan.motivo).toBe('updated_at');
    expect(plan.advertencia).toBeNull();
  });

  it('empate SIN fila propia: desempata por id y AVISA (§1.2)', () => {
    const rows = [
      fila({ id: 'bbb', head_id: 'hugo', updated_at: '2026-09-12T18:00:00Z' }),
      fila({ id: 'aaa', head_id: 'luka', updated_at: '2026-09-12T18:00:00Z' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.superviviente?.id).toBe('aaa');
    expect(plan.motivo).toBe('desempate-id');
    expect(plan.advertencia).toContain('empate');
  });

  it('nada usable y sin fila propia: desempata por id y AVISA', () => {
    const rows = [
      fila({ id: 'bbb', head_id: 'hugo', updated_at: null }),
      fila({ id: 'aaa', head_id: 'luka', updated_at: null }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.superviviente?.id).toBe('aaa');
    expect(plan.motivo).toBe('desempate-id');
    expect(plan.advertencia).toContain('updated_at');
  });

  it('una fila sin fecha NO le gana a una con fecha', () => {
    const rows = [
      fila({ id: 'sin-fecha', head_id: 'hugo', updated_at: null }),
      fila({ id: 'con-fecha', head_id: 'luka', updated_at: '2020-01-01T00:00:00Z' }),
    ];
    expect(planDeBucketPnl(rows, HECTOR).superviviente?.id).toBe('con-fecha');
  });

  it('EL MASTER IB: su línea ND bajo Ana queda fuera del plan (ni migrar ni borrar)', () => {
    const rows: FilaMigrable[] = [
      { profile_id: 'jose', id: 'linea-nd', head_id: 'ana', updated_at: '2026-09-15T00:00:00Z' },
      { profile_id: 'jose', id: 'pnl-vieja', head_id: 'luka', updated_at: '2026-08-01T00:00:00Z' },
      { profile_id: 'jose', id: 'pnl-propia', head_id: 'jose', updated_at: '2026-09-01T00:00:00Z' },
    ];
    const plan = planDeBucketPnl(rows, JOSE);
    // La línea ND es la más reciente de todas y aun así NO gana ni se borra.
    expect(plan.superviviente?.id).toBe('pnl-propia');
    expect(plan.aBorrar.map((r) => r.id)).toEqual(['pnl-vieja']);
    expect(plan.aBorrar.some((r) => r.id === 'linea-nd')).toBe(false);
    expect(plan.queda?.id).toBe('pnl-propia');
  });

  it('EL MASTER IB con SOLO su línea ND: no hay nada de PnL que tocar', () => {
    const rows: FilaMigrable[] = [
      { profile_id: 'jose', id: 'linea-nd', head_id: 'ana', updated_at: '2026-09-15T00:00:00Z' },
    ];
    const plan = planDeBucketPnl(rows, JOSE);
    expect(plan.sinCambios).toBe(true);
    expect(plan.aBorrar).toEqual([]);
  });

  it('nunca se borra la fila que queda en pie', () => {
    const rows = [
      fila({ id: 'a', head_id: 'hugo', updated_at: '2026-01-01T00:00:00Z' }),
      fila({ id: 'b', head_id: 'hector', updated_at: '2026-02-01T00:00:00Z' }),
      fila({ id: 'c', head_id: 'luka', updated_at: '2026-03-01T00:00:00Z' }),
    ];
    const plan = planDeBucketPnl(rows, HECTOR);
    expect(plan.aBorrar).not.toContain(plan.queda);
    expect(plan.aBorrar.length).toBe(rows.length - 1);
  });
});
