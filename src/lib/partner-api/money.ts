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

// ─────────────────────────────────────────────────────────────────────────────
// El total normalizado en dólares.
//
// ── POR QUÉ EXISTE, SI ARRIBA DICE QUE NO SE EXPONE NINGÚN ESCALAR ─────────
// Porque esa decisión se pasó de frenada. El razonamiento era bueno —un número
// suelto llamado `balance` invita a sumarse con otro de distinta unidad— pero
// la conclusión no: al no dar NINGÚN total, la conversión no desaparece, se
// muda al consumidor. Y cada consumidor la reconstruye por su cuenta y se
// equivoca distinto.
//
// Lo dijo Atlas el 2026-08-27 con un caso concreto: Kevin pidió ordenar los
// leads por equity, que presupone UN número por cliente. Lo que devolvíamos era
// un desglose por familia en unidades incomparables, y ordenar sumándolo da un
// resultado sin significado SIN NINGÚN ERROR.
//
// ── EL FACTOR ESTÁ MEDIDO, NO SUPUESTO ────────────────────────────────────
// Contra el CRM, que es la fuente externa: el ratio mediano entre lo que MT5
// registra como entrado y lo que la billetera del CRM registra como salido en
// dólares es 100,00 en cuentas Cent (n=218) y 1,00 en USD (n=356).
//
// ── LO QUE EL TOTAL DEJA FUERA, Y POR QUÉ ─────────────────────────────────
// El capital de PropFirm es VIRTUAL: es capital de desafío del broker, no
// dinero del cliente. Sumarlo a su equity diría que alguien con una cuenta de
// desafío de $200.000 tiene $200.000, y sobre eso se ordenaría una lista de
// llamadas. Va aparte y con su propio nombre.
// ─────────────────────────────────────────────────────────────────────────────

/** Centésimas de dólar por dólar en las cuentas Cent. Medido, no supuesto. */
export const CENTS_PER_USD = 100;

/** Un importe de MT5 llevado a dólares. */
export function toUsd(m: Money): number {
  return m.unit === 'cents' ? m.amount / CENTS_PER_USD : m.amount;
}

export interface NormalizedTotals {
  /** Dinero REAL del cliente en sus cuentas, en dólares. Sirve para ordenar. */
  realUsd: number;
  /** Capital de desafío de prop firm. NO es del cliente. Nunca se suma al real. */
  virtualUsd: number;
}

/**
 * Suma a dólares separando lo real de lo virtual.
 *
 * `familyOf` decide qué es virtual, con el mismo criterio que el resto del
 * módulo — no una segunda lista que pueda divergir.
 */
export function normalizeToUsd(
  cuentas: Array<{ group: string | null; amount: Money }>,
): NormalizedTotals {
  let realUsd = 0;
  let virtualUsd = 0;
  for (const c of cuentas) {
    const usd = toUsd(c.amount);
    if (isVirtualFamily(familyOf(c.group))) virtualUsd += usd;
    else realUsd += usd;
  }
  return {
    realUsd: Math.round(realUsd * 100) / 100,
    virtualUsd: Math.round(virtualUsd * 100) / 100,
  };
}
