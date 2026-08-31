import { describe, it, expect } from 'vitest';
import {
  selectUsableWithdrawals,
  CRM_PROCESSOR_PREFIX,
  CRM_WITHDRAWAL_ID_PREFIX,
  type CrmWithdrawalRow,
} from './withdrawals-from-crm';
import { CRM_ID_PREFIX } from './deposits-from-crm';

function row(partial: Partial<CrmWithdrawalRow> = {}): CrmWithdrawalRow {
  return {
    external_id: 'w1',
    requested_amount: 200.76,
    transaction_amount: 197.76,
    fee: 3,
    coin: 'USD',
    processor: 'PAYPROS_SPEI',
    status_raw: 'COMPLETED',
    processed_at: '2026-08-22T04:08:42.279Z',
    user_external_id: 'u1',
    ...partial,
  };
}

describe('selectUsableWithdrawals', () => {
  it('acepta el caso real: PAYPROS_SPEI aprobado, USD, con fecha', () => {
    const { usable, warnings } = selectUsableWithdrawals([row()]);
    expect(usable).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('reproduce los 6 aprobados de Vex Pro al 2026-08-31: US$ 2.617,62', () => {
    const importes = [30, 655, 150, 1531.86, 50, 200.76];
    const { usable } = selectUsableWithdrawals(
      importes.map((amount, i) => row({ external_id: `w${i}`, requested_amount: amount })),
    );
    const total = usable.reduce((s, r) => s + (r.requested_amount ?? 0), 0);
    expect(usable).toHaveLength(6);
    expect(total).toBeCloseTo(2_617.62, 2);
  });

  // ── Casos negativos: la mitad de los tests, como pide el repo ────────────

  it('descarta el que no tiene fecha de procesamiento, y lo dice', () => {
    const { usable, warnings } = selectUsableWithdrawals([row({ processed_at: null })]);
    expect(usable).toHaveLength(0);
    expect(warnings[0]).toContain('sin fecha');
  });

  it('descarta importe null y el aviso NO lo llama cero', () => {
    // `null` = «no sabemos cuánto salió». Tratarlo como 0 asentaría un retiro
    // de cero pesos y dejaría el libro descuadrado sin ninguna señal.
    const { usable, warnings } = selectUsableWithdrawals([row({ requested_amount: null })]);
    expect(usable).toHaveLength(0);
    expect(warnings[0]).toContain('null');
    expect(warnings[0]).not.toContain('con importe 0');
  });

  it('descarta importe 0 con un aviso distinto al de null', () => {
    const { warnings } = selectUsableWithdrawals([row({ requested_amount: 0 })]);
    expect(warnings[0]).toContain('con importe 0');
  });

  it('descarta importe negativo: un retiro no resta al revés', () => {
    const { usable } = selectUsableWithdrawals([row({ requested_amount: -50 })]);
    expect(usable).toHaveLength(0);
  });

  it('descarta una moneda que no sea USD — es la trampa de FairPay', () => {
    const { usable, warnings } = selectUsableWithdrawals([row({ coin: 'MXN' })]);
    expect(usable).toHaveLength(0);
    expect(warnings[0]).toContain('MXN');
  });

  it('trata `coin` nulo como USD: el CRM lo omite en las filas viejas', () => {
    const { usable } = selectUsableWithdrawals([row({ coin: null })]);
    expect(usable).toHaveLength(1);
  });

  it('no descarta por minúsculas ni espacios en la moneda', () => {
    const { usable } = selectUsableWithdrawals([row({ coin: ' usd ' })]);
    expect(usable).toHaveLength(1);
  });

  it('avisa por CADA descarte, no solo por el primero', () => {
    const { usable, warnings } = selectUsableWithdrawals([
      row({ external_id: 'a', processed_at: null }),
      row({ external_id: 'b', requested_amount: null }),
      row({ external_id: 'c', coin: 'COP' }),
      row({ external_id: 'd' }),
    ]);
    expect(usable.map((r) => r.external_id)).toEqual(['d']);
    expect(warnings).toHaveLength(3);
  });
});

describe('prefijos de procedencia', () => {
  it('el de retiros es DISTINTO del de depósitos', () => {
    // Con el mismo prefijo, un retiro y un depósito que compartieran id en
    // Orion colisionarían en (company, provider, external_id) y uno pisaría al
    // otro en silencio.
    expect(CRM_WITHDRAWAL_ID_PREFIX).not.toBe(CRM_ID_PREFIX);
    expect(CRM_WITHDRAWAL_ID_PREFIX.startsWith(CRM_ID_PREFIX)).toBe(false);
  });

  it('el filtro de processor es un PREFIJO: el rail viaja en el nombre', () => {
    // Hoy el único valor real es 'PAYPROS_SPEI' (México). Un `eq` exacto
    // dejaría afuera el próximo rail sin que fallara nada.
    expect('PAYPROS_SPEI'.startsWith(CRM_PROCESSOR_PREFIX)).toBe(true);
    expect('COINSBUY'.startsWith(CRM_PROCESSOR_PREFIX)).toBe(false);
  });
});
