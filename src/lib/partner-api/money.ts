// ─────────────────────────────────────────────────────────────────────────────
// Cómo viaja el dinero de MT5 hacia afuera.
//
// ── EL PROBLEMA QUE ESTE MÓDULO EXISTE PARA HACER IMPOSIBLE ────────────────
// Las cuentas de MT5 no comparten unidad. Medido el 2026-08-25 sobre Vex Pro:
//
//     familia    cuentas   "saldo" sumado
//     Cent        3.321      88.767.992    <-- 88% del total
//     Copy        4.341       7.204.744
//     PropFirm    1.114       4.635.816
//     Broker      7.467       1.838.482
//
// Las `Cent` están denominadas EN CENTAVOS y las `PropFirm` llevan capital
// virtual de desafío. Sumarlas da 101 millones contra 7,6 realmente
// depositados según Orion: un número sin significado, pero perfectamente
// creíble en una pantalla.
//
// ── POR QUÉ {amount, unit} Y NO amount CON unit AL LADO ────────────────────
// Porque un campo hermano se pierde en el primer `map` que alguien escriba, y
// no por descuido: un número suelto llamado `balance` INVITA a sumarlo. Con la
// unidad dentro del valor, sumar dos familias por accidente no produce un
// número plausible y equivocado — falla a la vista.
//
// Es la misma razón por la que no exponemos ningún total escalar, ni siquiera
// opcional: un campo que sólo se usa bien si el consumidor leyó la
// documentación es un campo que se va a usar mal.
//
// Y NO convertimos centavos a dólares. Haría falta asumir un factor; una
// conversión equivocada se propaga y nadie la ve, mientras que un dato crudo
// bien etiquetado siempre es recuperable.
// ─────────────────────────────────────────────────────────────────────────────

/** Unidad en la que está expresado un importe de MT5. */
export type MoneyUnit = 'cents' | 'account_currency';

/** Un importe que NO se puede sumar con otro de distinta unidad. */
export interface Money {
  amount: number;
  unit: MoneyUnit;
}

export interface AccountLike {
  group_name: string | null;
  account_balance: number | null;
  profit: number | null;
  deals_count: number | null;
}

export interface FamilyMoney {
  family: string;
  accounts: number;
  tradeCount: number;
  balance: Money;
  profit: Money;
  /** Capital de desafío, no dinero del cliente. */
  isVirtual: boolean;
}

/**
 * La familia es el segundo tramo del Group de MT5: `real\Cent\STP` → `Cent`.
 * Los separadores vienen como barra invertida.
 */
export function familyOf(group: string | null): string {
  if (!group) return 'unknown';
  const parts = group.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[1] ?? parts[0] ?? 'unknown';
}

export function unitOf(family: string): MoneyUnit {
  return family.toLowerCase() === 'cent' ? 'cents' : 'account_currency';
}

export function isVirtualFamily(family: string): boolean {
  return family.toLowerCase() === 'propfirm';
}

export function money(amount: number, family: string): Money {
  return { amount, unit: unitOf(family) };
}

/**
 * Agrupa el dinero por familia. Nunca devuelve un total: sumar entre familias
 * es justamente el error que este módulo impide.
 */
export function moneyByFamily(accounts: AccountLike[]): FamilyMoney[] {
  const acc = new Map<string, { accounts: number; balance: number; profit: number; tradeCount: number }>();

  for (const r of accounts) {
    const key = familyOf(r.group_name);
    const cur = acc.get(key) ?? { accounts: 0, balance: 0, profit: 0, tradeCount: 0 };
    cur.accounts += 1;
    cur.balance += r.account_balance ?? 0;
    cur.profit += r.profit ?? 0;
    cur.tradeCount += r.deals_count ?? 0;
    acc.set(key, cur);
  }

  return [...acc.entries()]
    .map(([family, v]) => ({
      family,
      accounts: v.accounts,
      tradeCount: v.tradeCount,
      balance: money(v.balance, family),
      profit: money(v.profit, family),
      isVirtual: isVirtualFamily(family),
    }))
    // Orden estable: dos llamadas iguales devuelven lo mismo.
    .sort((a, b) => a.family.localeCompare(b.family));
}
