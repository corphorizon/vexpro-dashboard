// Los DOS modos del endpoint —por correo y masivo— tienen que devolver el
// mismo resumen. Hoy comparten `summarize`, así que no pueden divergir; esta
// prueba existe para que siga siendo así.
//
// El riesgo es concreto y ya lo sufrimos hoy: Atlas no podía consumir el total
// normalizado porque creía que el masivo no lo traía. Esa vez fue un problema
// de tiempos —probaron contra el despliegue anterior— pero si algún día
// alguien reescribe una de las dos ramas a mano, el síntoma es idéntico: un
// consumidor que reconstruye la conversión por su cuenta y se equivoca solo.

import { describe, it, expect } from 'vitest';
import { summarize, type ActivityRow } from './route';

const fila = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  login: 1, email: 'x@y.com', group_name: 'real\\Broker\\STP', is_demo: false,
  deals_count: 10, profit: 100, first_deal_at: '2026-01-01T00:00:00Z',
  last_deal_at: '2026-08-01T00:00:00Z', account_balance: 500, equity: 520,
  registration_at: '2025-12-01T00:00:00Z', synced_at: '2026-08-27T00:00:00Z',
  ...over,
});

describe('el resumen que consumen los dos modos', () => {
  it('trae los tres campos normalizados que se usan para ordenar', () => {
    const r = summarize([fila()], 0);
    // Sin estos, ordenar por equity obliga al consumidor a reconstruir la
    // conversión — que es justo lo que el total normalizado vino a evitar.
    expect(r).toHaveProperty('accountEquityUsd');
    expect(r).toHaveProperty('accountBalanceUsd');
    expect(r).toHaveProperty('propFirmVirtualEquityUsd');
  });

  it('convierte las cuentas Cent y no las suma en crudo', () => {
    // 106.200 cents son 1.062 dólares. Es el caso que Atlas verificó a mano.
    const r = summarize([fila({ group_name: 'real\\Cent\\STP', account_balance: 106_200, equity: 106_200 })], 0);
    expect(r.accountBalanceUsd).toBe(1062);
    expect(r.accountEquityUsd).toBe(1062);
  });

  it('deja el capital de prop firm FUERA del total del cliente', () => {
    const r = summarize([
      fila({ account_balance: 100, equity: 100 }),
      fila({ login: 2, group_name: 'real\\PropFirm\\LeverageX12', account_balance: 200_000, equity: 200_000 }),
    ], 0);
    expect(r.accountBalanceUsd).toBe(100);
    expect(r.propFirmVirtualEquityUsd).toBe(200_000);
  });

  it('sin cuentas reales devuelve ceros, no NaN ni undefined', () => {
    // Un cliente sólo con demo. Un NaN acá envenena cualquier orden.
    const r = summarize([], 3);
    expect(r.accountEquityUsd).toBe(0);
    expect(r.accountBalanceUsd).toBe(0);
    expect(r.demoAccounts).toBe(3);
  });
});
