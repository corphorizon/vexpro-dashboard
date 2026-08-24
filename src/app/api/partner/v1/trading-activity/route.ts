// ─────────────────────────────────────────────────────────────────────────────
// GET /api/partner/v1/trading-activity
//
// La puerta por la que Atlas y los demás aplicativos leen la actividad de
// trading. Smart Dashboard es el ÚNICO que habla con el MySQL de MT5; acá se
// sirve lo ya espejado, nunca una consulta en vivo contra el broker.
//
// ── POR QUÉ TOKEN Y NO LISTA BLANCA DE IPs ─────────────────────────────────
// Porque Atlas corre en Vercel con IP de salida DINÁMICA — confirmado por las
// dos sesiones de Atlas, que además ya se comieron este problema con Pay-Pros:
// su endpoint de balance filtra por IP y Atlas simplemente no puede
// consumirlo. Un filtro por IP acá dejaría a Atlas afuera, punto.
//
// ── DECISIONES DE CONTRATO (pedidas por Atlas, y por qué) ──────────────────
//  · Un correo sin cuentas en MT5 devuelve 200 con nulos, NO 404. "Este
//    cliente no opera" es un dato, no un error; un 404 obligaría a cada
//    consumidor a distinguir "no existe" de "falló la llamada".
//  · Se devuelve el correo NORMALIZADO con el que se unió, para que el
//    consumidor pueda auditar la unión en vez de confiar en ella.
//  · `asOf` en cada respuesta: quien la muestre tiene que poder decir de
//    cuándo es el dato.
//  · El detalle por cuenta sólo cuando se pide UN correo. Por operación no se
//    ofrece: son 68,4 millones de filas y nadie las necesita.
//
// ── FUENTE DE VERDAD, Y SUS LÍMITES (Kevin, 2026-08-25) ────────────────────
// Para la ACTIVIDAD de trading manda MT5: cuántas cuentas reales tiene, cuánto
// operó, cuándo fue su primera y última operación. Ahí Orion no sabe.
//
// EL DINERO NO. Y esto se midió, no se supone:
//
//   familia     cuentas   "saldo" sumado
//   Cent          3.321      88.767.992   <-- 88% del total
//   Copy          4.341       7.204.744
//   PropFirm      1.114       4.635.816
//   Broker        7.467       1.838.482
//
// Las cuentas Cent están denominadas EN CENTAVOS y las PropFirm llevan capital
// virtual de desafío, que no es plata del cliente. Sumar `Balance` entre
// familias da un número sin significado: el total de MT5 son 101 millones
// contra 7,6 millones realmente depositados según Orion, y difieren 6.924 de
// 6.985 clientes.
//
// Por eso NO se devuelve un "saldo del cliente" agregado. El dinero va
// desglosado por familia, con su unidad a la vista, y quien consuma decide.
//
// TAMPOCO cubre depósitos ni retiros. Son movimientos de la PLATAFORMA
// (pasarela → billetera) y viven en Orion; MT5 sólo ve las transferencias
// internas billetera → cuenta de trading, que es otra cosa. `totalDeposits`,
// `depositCount`, `lastDepositAt` y `totalWithdrawals` se quedan en Orion —
// además el traspaso a Retención se dispara con `depositCount`, así que
// cambiarle la fuente rompería la operación del call center.
//
// El riesgo que todo esto evita es concreto: que queden DOS NÚMEROS DISTINTOS
// en pantalla delante de un agente hablando con el cliente.
//
// ── LO QUE NUNCA SALE POR ACÁ ──────────────────────────────────────────────
// Contraseñas de MetaTrader (master/investor). No están en nuestro espejo y no
// deben estarlo: Orion las guarda en texto plano y Atlas tiene tests que
// fallan si alguna se cuela en un mapeo. Esta ruta sirve agregados; si algún
// día alguien agrega columnas al espejo, esta lista es el recordatorio.
//
// ── AVISO PARA QUIEN CONSUMA EN MASA ───────────────────────────────────────
// `lastTradeAt` es histórico. Si alguien construye un detector de "dejó de
// operar" sobre esto, el PRIMER barrido ve todo el historial como si acabara
// de pasar. Le acaba de ocurrir a Atlas con los depósitos: una columna que
// nació en cero interpretó 7.054 depósitos viejos como nuevos y disparó 45
// traspasos automáticos antes de que lo cortaran. Anclá el valor inicial
// ANTES de encender cualquier detector.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyPartnerAuth } from '@/lib/partner-api/auth';
import { apiError } from '@/lib/api-error';
import { moneyByFamily, money, familyOf } from '@/lib/partner-api/money';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Techo de filas por página. Protege al servidor y obliga a paginar. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

interface ActivityRow {
  login: number;
  email: string | null;
  group_name: string | null;
  is_demo: boolean;
  deals_count: number | null;
  profit: number | null;
  first_deal_at: string | null;
  last_deal_at: string | null;
  account_balance: number | null;
  registration_at: string | null;
  synced_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const admin = createAdminClient();
    const auth = await verifyPartnerAuth(request, admin, ['mt5:read']);
    if (auth instanceof NextResponse) return auth;

    // `new URL(request.url)` y no `request.nextUrl`: funciona igual en
    // producción y con un Request estándar, así la ruta se puede probar sin
    // fabricar un NextRequest.
    const p = new URL(request.url).searchParams;
    const email = p.get('email')?.trim().toLowerCase() || null;
    const since = p.get('since');
    // Segunda mitad del cursor: el último `login` ya entregado para esa misma
    // marca de tiempo. Sin él no se pueden desempatar las filas que comparten
    // `synced_at` (ver más abajo).
    const afterLoginRaw = p.get('afterLogin');
    const afterLogin =
      afterLoginRaw !== null && /^\d+$/.test(afterLoginRaw) ? Number(afterLoginRaw) : null;
    const rawLimit = Number(p.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);

    // El alcance sale del TOKEN, nunca de un parámetro: es lo que impide que
    // un token de una organización lea la de al lado cambiando un query param.
    let q = admin
      .from('mt5_account_activity')
      .select(
        'login, email, group_name, is_demo, deals_count, profit, first_deal_at, last_deal_at, account_balance, registration_at, synced_at',
      )
      .eq('company_id', auth.companyId);

    if (email) {
      q = q.eq('email', email);
    } else {
      // Modo masivo. `since` es el cursor de "cambió desde": sin él, cada
      // corrida del consumidor arrastraría el espejo entero.
      if (since) {
        const d = new Date(since);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json(
            { success: false, error: 'El parámetro `since` debe ser una fecha ISO 8601.' },
            { status: 400 },
          );
        }
        const iso = d.toISOString();

        // ── POR QUÉ EL CURSOR ES COMPUESTO ───────────────────────────────────
        // Un sync escribe muchas filas con la MISMA marca de tiempo. Con un
        // cursor de sólo `synced_at > T`, si una página corta en medio de un
        // grupo que comparte T, la llamada siguiente se salta las que
        // quedaron: pérdida de datos silenciosa, y el consumidor nunca se
        // entera de que le falta un cliente.
        //
        // Por eso el cursor es (synced_at, login) y la condición es
        // "posterior a T, o igual a T con un login mayor".
        if (afterLogin !== null) {
          q = q.or(`synced_at.gt.${iso},and(synced_at.eq.${iso},login.gt.${afterLogin})`);
        } else {
          q = q.gte('synced_at', iso);
        }
      }
      q = q
        .order('synced_at', { ascending: true })
        .order('login', { ascending: true })
        .limit(limit);
    }

    const { data, error } = await q;
    if (error) return apiError('partner/trading-activity', error, { status: 500 });

    const rows = (data ?? []) as unknown as ActivityRow[];
    const asOf = rows.reduce<string | null>(
      (max, r) => (!max || r.synced_at > max ? r.synced_at : max),
      null,
    );

    // ── Un correo: resumen + detalle ligero por cuenta ──────────────────────
    if (email) {
      const real = rows.filter((r) => !r.is_demo);
      return NextResponse.json({
        success: true,
        // Procedencia explícita: para cuentas de trading, MT5 manda sobre
        // Orion. Quien consuma no debería tener que adivinarlo.
        source: TRADING_SOURCE,
        // El correo con el que se unió, normalizado, para poder auditarlo.
        email,
        asOf,
        // 200 con nulos, no 404: "no opera" es un dato.
        found: rows.length > 0,
        summary: summarize(real, rows.length - real.length),
        // Cada cuenta lleva su importe CON la unidad dentro, por lo mismo que
        // el desglose: un número suelto llamado `balance` invita a sumarse con
        // el de al lado, que puede estar en otra unidad.
        accounts: real.map((r) => {
          const family = familyOf(r.group_name);
          return {
            login: r.login,
            group: r.group_name,
            family,
            balance: money(r.account_balance ?? 0, family),
            profit: money(r.profit ?? 0, family),
            tradeCount: r.deals_count ?? 0,
            firstTradeAt: r.first_deal_at,
            lastTradeAt: r.last_deal_at,
            registeredAt: r.registration_at,
          };
        }),
        notice: HISTORICAL_NOTICE,
      });
    }

    // ── Masivo: una fila por CLIENTE, no por cuenta ─────────────────────────
    // El consumidor razona por cliente; devolver cuentas sueltas lo obligaría
    // a agrupar del otro lado y a repetir la regla de excluir demo.
    const byEmail = new Map<string, ActivityRow[]>();
    for (const r of rows) {
      const key = r.email ?? '';
      if (!key) continue;
      const list = byEmail.get(key) ?? [];
      list.push(r);
      byEmail.set(key, list);
    }

    const items = [...byEmail.entries()].map(([mail, list]) => {
      const real = list.filter((r) => !r.is_demo);
      return { email: mail, ...summarize(real, list.length - real.length) };
    });

    // Las dos mitades del cursor salen de la ÚLTIMA fila entregada, no del
    // máximo: es lo que garantiza que la próxima página retome exactamente
    // donde ésta terminó, incluso a mitad de un grupo con la misma marca.
    const last = rows.length > 0 ? rows[rows.length - 1]! : null;

    return NextResponse.json({
      success: true,
      source: TRADING_SOURCE,
      asOf,
      // `count` son CLIENTES; `limit` y `hasMore` son FILAS (cuentas). Un
      // cliente con cinco cuentas ocupa cinco filas de la página.
      count: items.length,
      rows: rows.length,
      // Pasar las dos de vuelta en la próxima llamada. Con `items` vacío no
      // hay nada nuevo y el consumidor conserva su cursor anterior.
      nextSince: last ? last.synced_at : since,
      nextAfterLogin: last ? last.login : afterLogin,
      hasMore: rows.length >= limit,
      items,
      notice: HISTORICAL_NOTICE,
    });
  } catch (err) {
    return apiError('partner/trading-activity', err, { status: 500 });
  }
}

/**
 * Procedencia del dato. Va en toda respuesta por la decisión de arriba: para
 * cuentas de trading, MT5 es la fuente de verdad y Orion no.
 */
const TRADING_SOURCE = {
  system: 'mt5' as const,
  /** Acá MT5 manda sobre Orion. Son conteos y fechas: comparables siempre. */
  authoritativeFor: ['accounts', 'tradeCount', 'firstTradeAt', 'lastTradeAt'],
  /** Acá NO. Sigue mandando Orion; MT5 no los ve o no son comparables. */
  notAuthoritativeFor: [
    'totalDeposits',
    'depositCount',
    'lastDepositAt',
    'totalWithdrawals',
    'walletBalance',
  ],
  note:
    'MT5 manda para la ACTIVIDAD de trading (cuentas, operaciones, fechas). NO para depósitos ni ' +
    'retiros: esos son movimientos de la plataforma y viven en Orion. Tampoco hay un "saldo del ' +
    'cliente" único — ver moneyNotice.',
  moneyNotice:
    'El dinero va desglosado por familia de cuenta y NO sumado: las cuentas Cent están ' +
    'denominadas en CENTAVOS y las PropFirm llevan capital virtual de desafío. Sumarlas da ' +
    '101 millones contra 7,6 realmente depositados. Cada familia trae su propia unidad.',
};

const HISTORICAL_NOTICE =
  'lastTradeAt es histórico. Si construís un detector de "dejó de operar", anclá el valor inicial ' +
  'ANTES de encenderlo: el primer barrido ve todo el historial como si acabara de pasar.';

/**
 * Resume las cuentas REALES de un cliente. Las demo se cuentan aparte y nunca
 * suman: operar en demo no es evidencia de haber operado el dinero depositado.
 */
function summarize(real: ActivityRow[], demoCount: number) {
  const times = (xs: (string | null)[]) =>
    xs.filter((x): x is string => !!x).map((x) => new Date(x).getTime());
  const firsts = times(real.map((r) => r.first_deal_at));
  const lasts = times(real.map((r) => r.last_deal_at));

  return {
    // Conteos y fechas: comparables entre familias, se pueden sumar.
    accounts: real.length,
    demoAccounts: demoCount,
    tradeCount: real.reduce((s, r) => s + (r.deals_count ?? 0), 0),
    firstTradeAt: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
    lastTradeAt: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,

    // El dinero NO se suma entre familias (ver cabecera). Va desglosado con la
    // unidad a la vista, y quien consuma decide qué hacer con cada una.
    money: moneyByFamily(real),
  };
}

