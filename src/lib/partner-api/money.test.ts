// Lo que se fija acá es que sea IMPOSIBLE sumar dinero de familias distintas
// por accidente. Medido en producción: sumar todo daba 101 millones contra
// 7,6 realmente depositados, y el 88% del error venía de las cuentas Cent,
// que están denominadas en centavos.

import { describe, it, expect } from 'vitest';
import { moneyByFamily, familyOf, unitOf, isVirtualFamily, normalizeToUsd } from './money';

const cuenta = (group: string | null, balance: number, profit = 0, deals = 1) => ({
  group_name: group,
  account_balance: balance,
  profit,
  deals_count: deals,
});

describe('familyOf', () => {
  it('saca la familia del Group de MT5, que usa barra invertida', () => {
    expect(familyOf('real\\Cent\\STP')).toBe('Cent');
    expect(familyOf('real\\PropFirm\\LeverageX12')).toBe('PropFirm');
    expect(familyOf('demo\\Broker\\Synthetics')).toBe('Broker');
  });

  it('no inventa una familia cuando no la hay', () => {
    expect(familyOf(null)).toBe('unknown');
    expect(familyOf('')).toBe('unknown');
    // Un Group de un solo tramo: se usa ese, no se rellena con algo plausible.
    expect(familyOf('preliminary')).toBe('preliminary');
  });
});

describe('unidad por familia', () => {
  it('Cent está en centavos: es el 88% del error si se ignora', () => {
    expect(unitOf('Cent')).toBe('cents');
    expect(unitOf('cent')).toBe('cents');
  });

  it('el resto va en la moneda de la cuenta', () => {
    for (const f of ['Broker', 'Copy', 'PropFirm', 'unknown']) {
      expect(unitOf(f)).toBe('account_currency');
    }
  });

  it('PropFirm se marca como capital virtual: no es plata del cliente', () => {
    expect(isVirtualFamily('PropFirm')).toBe(true);
    expect(isVirtualFamily('Broker')).toBe(false);
  });
});

describe('moneyByFamily', () => {
  it('separa por familia en vez de sumar', () => {
    const out = moneyByFamily([
      cuenta('real\\Cent\\STP', 1_000_000),
      cuenta('real\\Broker\\ECN', 500),
    ]);
    expect(out).toHaveLength(2);
    const cent = out.find((f) => f.family === 'Cent')!;
    const broker = out.find((f) => f.family === 'Broker')!;
    expect(cent.balance).toEqual({ amount: 1_000_000, unit: 'cents' });
    expect(broker.balance).toEqual({ amount: 500, unit: 'account_currency' });
  });

  it('NO devuelve ningún total escalar', () => {
    // Un campo llamado `total` invita a usarse, y con las Cent siendo el 88%
    // del volumen cualquier total queda dominado por el error de unidad.
    const out = moneyByFamily([cuenta('real\\Cent\\STP', 100)]);
    const claves = Object.keys(out[0]!);
    expect(claves).not.toContain('total');
    expect(claves).not.toContain('balanceTotal');
  });

  it('la unidad va DENTRO del valor, no como campo hermano', () => {
    // Un hermano se pierde en el primer map que alguien escriba; un objeto no
    // se suma por accidente porque la suma falla a la vista.
    const [f] = moneyByFamily([cuenta('real\\Cent\\STP', 100)]);
    expect(f!.balance).toHaveProperty('unit');
    expect(f).not.toHaveProperty('unit');
    // Y sumar dos importes de distinta unidad no da un número creíble.
    const suma = (moneyByFamily([cuenta('real\\Cent\\STP', 100)])[0]!.balance as unknown as number) +
      (moneyByFamily([cuenta('real\\Broker\\ECN', 5)])[0]!.balance as unknown as number);
    expect(Number.isFinite(suma)).toBe(false);
  });

  it('agrupa varias cuentas de la misma familia', () => {
    const [f] = moneyByFamily([
      cuenta('real\\Broker\\ECN', 100, 10, 5),
      cuenta('real\\Broker\\STP', 200, 20, 7),
    ]);
    expect(f!.accounts).toBe(2);
    expect(f!.tradeCount).toBe(12);
    expect(f!.balance.amount).toBe(300);
    expect(f!.profit.amount).toBe(30);
  });

  it('trata los nulos como cero sin romperse', () => {
    const [f] = moneyByFamily([
      { group_name: 'real\\Broker\\ECN', account_balance: null, profit: null, deals_count: null },
    ]);
    expect(f!.balance.amount).toBe(0);
    expect(f!.tradeCount).toBe(0);
  });

  it('el orden es estable entre llamadas iguales', () => {
    const filas = [cuenta('real\\Cent\\A', 1), cuenta('real\\Broker\\B', 2), cuenta('real\\Copy\\C', 3)];
    expect(moneyByFamily(filas).map((f) => f.family)).toEqual(
      moneyByFamily([...filas].reverse()).map((f) => f.family),
    );
  });
});

describe('total normalizado a dólares', () => {
  it('una cuenta Cent vale la centésima parte de su número', () => {
    // Medido contra el CRM: el ratio mediano entre lo que MT5 registra y lo
    // que la billetera descontó en dólares es 100,00 en 218 cuentas Cent.
    // Sin dividir, un cliente con 215,57 en una Cent aparece con $215 en vez
    // de $2,16 — y se ordena cien puestos por encima de donde va.
    const r = normalizeToUsd([
      { group: 'real\\Cent\\STP', amount: { amount: 215.57, unit: 'cents' } },
    ]);
    expect(r.realUsd).toBe(2.16);
  });

  it('una cuenta en dólares vale su número', () => {
    const r = normalizeToUsd([
      { group: 'real\\Broker\\STP', amount: { amount: 500, unit: 'account_currency' } },
    ]);
    expect(r.realUsd).toBe(500);
  });

  it('el capital de prop firm NO entra en el total del cliente', () => {
    // Es capital de desafío del broker. Sumarlo diría que alguien con una
    // cuenta de $200.000 tiene $200.000, y sobre eso se ordenaría a quién
    // llamar primero.
    const r = normalizeToUsd([
      { group: 'real\\Broker\\STP', amount: { amount: 100, unit: 'account_currency' } },
      { group: 'real\\PropFirm\\LeverageX12', amount: { amount: 200000, unit: 'account_currency' } },
    ]);
    expect(r.realUsd).toBe(100);
    expect(r.virtualUsd).toBe(200000);
  });

  it('mezcla Cent y dólares sin que la Cent domine', () => {
    // El caso que motivó todo: sumar sin convertir daría 10.215,57 y pondría
    // a este cliente por delante de uno que tiene diez mil dólares de verdad.
    const r = normalizeToUsd([
      { group: 'real\\Cent\\STP', amount: { amount: 10000, unit: 'cents' } },
      { group: 'real\\Broker\\STP', amount: { amount: 215.57, unit: 'account_currency' } },
    ]);
    expect(r.realUsd).toBe(315.57);
  });

  it('sin cuentas devuelve cero, no NaN', () => {
    expect(normalizeToUsd([])).toEqual({ realUsd: 0, virtualUsd: 0 });
  });
});
