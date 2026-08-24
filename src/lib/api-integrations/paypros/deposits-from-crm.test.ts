// Acá se decide qué depósito de Pay-Pros entra al libro. Una regla mal puesta
// no rompe nada visible: mueve plata que no existe, y eso se descubre meses
// después conciliando a mano.

import { describe, it, expect } from 'vitest';
import {
  selectUsableDeposits,
  CRM_ID_PREFIX,
  CRM_PAYMENT_PROVIDER,
  type CrmDepositRow,
} from './deposits-from-crm';

const base: CrmDepositRow = {
  external_id: 'dep-1',
  amount_paid: 50,
  coin: 'USD',
  deposit_at: '2026-08-21T19:36:55.595Z',
  external_payment_id: 'abc123',
  status_raw: 'COMPLETED',
  user_external_id: 'user-1',
};

describe('selectUsableDeposits', () => {
  it('deja pasar un depósito completo', () => {
    const { usable, warnings } = selectUsableDeposits([base]);
    expect(usable).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('descarta el que no tiene fecha, y lo dice', () => {
    const { usable, warnings } = selectUsableDeposits([{ ...base, deposit_at: null }]);
    expect(usable).toHaveLength(0);
    expect(warnings[0]).toContain('sin fecha');
  });

  it('descarta importe nulo, cero y negativo', () => {
    // El cero es el caso real: en Orion los CANCELLED y los IN_REVIEW traen
    // amount_paid = 0. Si entraran, el libro sumaría movimientos de $0 que no
    // ocurrieron.
    for (const amount of [null, 0, -10]) {
      const { usable, warnings } = selectUsableDeposits([{ ...base, amount_paid: amount }]);
      expect(usable).toHaveLength(0);
      expect(warnings[0]).toContain('sin importe');
    }
  });

  it('no descarta en silencio: un aviso por cada descarte', () => {
    const { usable, warnings } = selectUsableDeposits([
      base,
      { ...base, external_id: 'dep-2', deposit_at: null },
      { ...base, external_id: 'dep-3', amount_paid: 0 },
    ]);
    expect(usable.map((r) => r.external_id)).toEqual(['dep-1']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('dep-2');
    expect(warnings.join(' ')).toContain('dep-3');
  });
});

describe('contrato con el resto del sistema', () => {
  it('el prefijo distingue el origen: sin él no se detecta el doble conteo', () => {
    // Si alguien registra la URL del webhook, éste escribe con el uid de
    // Pay-Pros como clave. El prefijo es lo único que permite ver que hay dos
    // fuentes vivas contando el mismo depósito.
    expect(CRM_ID_PREFIX).toBe('crm:');
  });

  it('el nombre del proveedor es el que usa Orion, en mayúsculas', () => {
    // Los valores reales de deposits.paymentProvider son UNIPAYMENT, FAIRPAY,
    // PAYPROS y MUWE. Cambiar esta cadena a 'paypros' devuelve 0 filas sin
    // error: el sync quedaría en verde trayendo nada.
    expect(CRM_PAYMENT_PROVIDER).toBe('PAYPROS');
  });
});
