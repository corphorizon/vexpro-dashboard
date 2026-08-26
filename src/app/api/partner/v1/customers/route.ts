// ─────────────────────────────────────────────────────────────────────────────
// GET /api/partner/v1/customers
//
// Los datos de cliente que Atlas consume hoy directo de Orion Mongo. Smart
// Dashboard pasa a ser el único que se conecta y los sirve por acá (decisión
// de Kevin, 2026-08-25); Atlas deja su propio cron y sus credenciales.
//
// ── NULL Y CERO NO SON LO MISMO ────────────────────────────────────────────
// Es la trampa que Atlas señaló y que aquí se respeta: `null` significa "no se
// calculó", `0` significa "es cero". En el modelo de Atlas estos campos tienen
// `@default(0)` y no distinguen, y eso rompe en silencio — un cliente con
// 4.000 dólares se muestra en cero si el dato no llegó, y el segmento
// "depositó y no tiene cuenta live" miente sin que nadie lo note.
//
// ── EL DINERO DE ACÁ NO ES EL DE MT5 ───────────────────────────────────────
// `walletBalance` es el saldo de BILLETERA (wallets con walletType=BALANCE).
// NO es el saldo de las cuentas de trading: eso vive en
// /api/partner/v1/trading-activity, va desglosado por familia y con su unidad,
// porque las cuentas Cent están en centavos. Son dos columnas distintas, no
// una que reemplaza a la otra.
//
// Depósitos y retiros son movimientos de la PLATAFORMA y mandan desde acá:
// MT5 sólo ve las transferencias internas billetera → cuenta.
//
// ── QUÉ IMPORTE ES CADA UNO (medido, no supuesto) ──────────────────────────
// Orion guarda DOS importes por movimiento, y elegir mal infla los números sin
// dar error. Medido el 2026-08-25 sobre Vex Pro:
//
//   DEPÓSITOS (17.776 completados)
//     depositValue   $8.122.721  ← lo que el cliente DECLARÓ que iba a mandar
//     amountPaid     $7.777.399  ← lo que REALMENTE llegó        [usamos éste]
//     inflado si se elige mal: $345.322 (difieren en el 24% de los casos)
//
//   RETIROS (12.061 completados)  ← OJO: acá NO es "declarado contra real"
//     requestedAmount $4.891.800 ← lo que sale de la BILLETERA  [usamos éste]
//     transactionAmount $4.856.793 ← lo que el cliente RECIBE por fuera
//     fee                $35.013  ← se lo queda el broker
//
// Los dos importes de retiro son REALES: miden hechos distintos. El desempate
// lo dio otra vez `wallettransfers`: sobre 3.628 clientes donde difieren, lo
// descontado del saldo coincide con `requestedAmount` en 2.978 y con
// `transactionAmount` en CERO.
//
// EL CRITERIO ES LA BILLETERA, en los dos lados: lo que ENTRÓ (`amountPaid`,
// 285 a 0) menos lo que SALIÓ (`requestedAmount`, 2.978 a 0).
//
// ── DEFINICIÓN DEL NEGOCIO (Kevin, 2026-08-25) ─────────────────────────────
// Textual: "al cliente le descontamos 100 de su balance; para el broker el
// retiro es de 97 más la comisión que cobre el procesador".
//
// O sea que hay DOS respuestas correctas según quién pregunte, y este endpoint
// sirve una sola:
//
//   PERSPECTIVA DEL CLIENTE  → `requestedAmount` (100). Es lo que salió de su
//     saldo, y es la que corresponde a "cuánto puso menos cuánto sacó". Es la
//     que sirve este endpoint, porque quien lo consume —La Base, Retención,
//     la ficha 360— razona sobre el cliente.
//
//   PERSPECTIVA DEL BROKER   → `transactionAmount` (97) más lo que cobre el
//     procesador. Es la salida de caja real. NO se sirve acá: quien necesite
//     tesorería tiene que pedir ese otro número explícitamente, porque los dos
//     son ciertos y confundirlos es el error que este bloque existe para
//     evitar.
//
// ── sourceUpdatedAt NO SIRVE PARA DETECTAR CAMBIOS ─────────────────────────
// Es el `updatedAt` de Orion: dice cuándo cambió el cliente EN EL ORIGEN. Pero
// los agregados de dinero se calculan de ESTE lado, así que un saldo puede
// cambiar sin que `sourceUpdatedAt` se mueva ni un milisegundo.
//
// A Atlas le pasó al consumirnos (2026-08-25): su escritura por lotes descarta
// las filas cuyo `sourceUpdatedAt` no cambió, así que el perfil volvía idéntico
// y el saldo nuevo NO SE ESCRIBÍA NUNCA. Sin error, sin aviso: un saldo
// congelado para siempre.
//
// Quien consuma esto tiene que COMPARAR VALORES para saber si algo cambió.
// `nextSince`/`nextAfterId` son otra cosa: ésos son nuestro reloj (`synced_at`)
// y existen para no releer lo ya leído, no para decidir si una fila cambió.
//
// ── LO QUE NUNCA SALE ──────────────────────────────────────────────────────
// Contraseñas de MetaTrader, direcciones de retiro, documentos de KYC. No
// están en el espejo porque la proyección que va a Mongo no las pide (ver
// crm-sync/aggregates.ts y el test que lo fija). De KYC sale el estado y el
// nivel, nunca un documento.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyPartnerAuth } from '@/lib/partner-api/auth';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

const AGG_COLS =
  'user_external_id, email, wallet_balance, total_deposits, deposit_count, last_deposit_at, ' +
  'total_withdrawals, accounts_count, live_accounts_count, social_accounts_count, kyc_level, ' +
  'enabled_withdrawals, client_id, synced_at';

const PROFILE_COLS =
  'user_external_id, username, email, country, status, kyc_status, user_type, register_date, ' +
  'sponsor_username, rank, source_updated_at, first_name, last_name, phone_raw, ' +
  'phone_country_code, country_iso, language, sponsor_email, ib_program_name, ' +
  'ib_program_broker_name';

interface AggRow {
  user_external_id: string;
  email: string | null;
  wallet_balance: number | null;
  total_deposits: number | null;
  deposit_count: number | null;
  last_deposit_at: string | null;
  total_withdrawals: number | null;
  accounts_count: number | null;
  live_accounts_count: number | null;
  social_accounts_count: number | null;
  kyc_level: string | null;
  enabled_withdrawals: boolean | null;
  client_id: string | null;
  synced_at: string;
}

interface ProfileRow {
  user_external_id: string;
  username: string | null;
  email: string | null;
  country: string | null;
  status: string | null;
  kyc_status: string | null;
  user_type: string | null;
  register_date: string | null;
  sponsor_username: string | null;
  rank: string | null;
  source_updated_at: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_raw: string | null;
  phone_country_code: string | null;
  country_iso: string | null;
  language: string | null;
  sponsor_email: string | null;
  ib_program_name: string | null;
  ib_program_broker_name: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const admin = createAdminClient();
    const auth = await verifyPartnerAuth(request, admin, ['mt5:read']);
    if (auth instanceof NextResponse) return auth;

    const p = new URL(request.url).searchParams;
    const email = p.get('email')?.trim().toLowerCase() || null;
    const userId = p.get('userId')?.trim() || null;
    const since = p.get('since');
    const afterIdRaw = p.get('afterId');
    const afterId = afterIdRaw && afterIdRaw.trim() ? afterIdRaw.trim() : null;
    const rawLimit = Number(p.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);

    // El alcance sale del TOKEN, nunca de un parámetro.
    let q = admin.from('crm_customer_aggregates').select(AGG_COLS).eq('company_id', auth.companyId);

    if (email) q = q.eq('email', email);
    else if (userId) q = q.eq('user_external_id', userId);
    else {
      if (since) {
        const d = new Date(since);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json(
            { success: false, error: 'El parámetro `since` debe ser una fecha ISO 8601.' },
            { status: 400 },
          );
        }
        const iso = d.toISOString();
        // Cursor COMPUESTO (synced_at, user_external_id) por lo mismo que en
        // trading-activity: un recálculo escribe miles de filas con la misma
        // marca, y con un cursor simple una página que corte en medio de un
        // grupo empatado se saltaría el resto en silencio.
        if (afterId) {
          q = q.or(
            `synced_at.gt.${iso},and(synced_at.eq.${iso},user_external_id.gt.${afterId})`,
          );
        } else {
          q = q.gte('synced_at', iso);
        }
      }
      q = q
        .order('synced_at', { ascending: true })
        .order('user_external_id', { ascending: true })
        .limit(limit);
    }

    const { data, error } = await q;
    if (error) return apiError('partner/customers', error, { status: 500 });

    const aggs = (data ?? []) as unknown as AggRow[];

    // El perfil va aparte para no duplicar columnas en dos tablas. Se trae
    // sólo para las filas de esta página, y EN TROZOS.
    //
    // Los trozos no son una optimización: PostgREST manda el filtro `in` en la
    // URL, y con 1.000 uuid de 36 caracteres son ~37 KB — más de lo que
    // aguanta, así que devolvía 500. Medido: 500 filas pasan, 1.000 revientan.
    // Lo encontró el script de comparación de Atlas en su primera corrida,
    // paginando de a 1.000, que es justo el borde que un uso normal no toca.
    const ids = aggs.map((a) => a.user_external_id);
    const profiles = new Map<string, ProfileRow>();
    const ID_CHUNK = 200;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data: prof, error: pErr } = await admin
        .from('crm_user_snapshots')
        .select(PROFILE_COLS)
        .eq('company_id', auth.companyId)
        .in('user_external_id', ids.slice(i, i + ID_CHUNK));
      if (pErr) return apiError('partner/customers perfiles', pErr, { status: 500 });
      for (const r of (prof ?? []) as unknown as ProfileRow[]) profiles.set(r.user_external_id, r);
    }

    const items = aggs.map((a) => shape(a, profiles.get(a.user_external_id) ?? null));
    const asOf = aggs.reduce<string | null>((max, r) => (!max || r.synced_at > max ? r.synced_at : max), null);
    const last = aggs.length > 0 ? aggs[aggs.length - 1]! : null;

    if (email || userId) {
      return NextResponse.json({
        success: true,
        source: CUSTOMER_SOURCE,
        asOf,
        // 200 con nulos y no 404: "no existe" es un dato, no un error.
        found: items.length > 0,
        customer: items[0] ?? null,
      });
    }

    return NextResponse.json({
      success: true,
      source: CUSTOMER_SOURCE,
      asOf,
      count: items.length,
      nextSince: last ? last.synced_at : since,
      nextAfterId: last ? last.user_external_id : afterId,
      hasMore: aggs.length >= limit,
      items,
    });
  } catch (err) {
    return apiError('partner/customers', err, { status: 500 });
  }
}

const CUSTOMER_SOURCE = {
  system: 'orion' as const,
  authoritativeFor: [
    'sourceUpdatedAt',
    'walletBalance',
    'totalDeposits',
    'depositCount',
    'lastDepositAt',
    'totalWithdrawals',
    'status',
    'kycStatus',
    'kycLevel',
  ],
  note:
    'Movimientos de la PLATAFORMA y perfil del cliente. Para la ACTIVIDAD de trading (cuántas ' +
    'cuentas operan, cuánto operó, última operación) manda MT5: ver /api/partner/v1/trading-activity.',
  amountNotice:
    'El criterio es LA BILLETERA en los dos lados: totalDeposits es lo que ENTRÓ a ella ' +
    '(amountPaid) y totalWithdrawals lo que SALIÓ de ella (requestedAmount). Orion guarda además ' +
    'depositValue —la intención del usuario, NO es dinero— y transactionAmount —lo que el cliente ' +
    'recibe por fuera, ya neto de comisión—. Definición del negocio: al cliente se le descuentan ' +
    '100 de su balance; para el broker ese retiro es de 97 más la comisión del procesador. Este ' +
    'endpoint sirve la PERSPECTIVA DEL CLIENTE (100). Para tesorería hace falta el otro número, y ' +
    'no se sirve acá: los dos son ciertos y confundirlos es el error a evitar.',
  nullNotice:
    'null significa "no se calculó" y 0 significa "es cero". No los mezcles: un cliente con dinero ' +
    'se mostraría en cero y los segmentos que dependen de esto mentirían sin dar error.',
  changeDetectionNotice:
    'NO uses sourceUpdatedAt para decidir si una fila cambió. Es el reloj del ORIGEN (Orion), no el ' +
    'nuestro. Estos campos se sirven desde nuestra tabla de agregados, que se escribe DESPUÉS y por ' +
    'un proceso distinto al del perfil, así que cambian SIN que sourceUpdatedAt se mueva: kycLevel, ' +
    'enabledWithdrawals, walletBalance, totalDeposits, depositCount, lastDepositAt, totalWithdrawals, ' +
    'accountsCount, liveAccountsCount, socialAccountsCount. Ojo con los dos primeros: NO son dinero ' +
    'y se leen como campos de perfil, que es exactamente por lo que se pasan por alto. ' +
    'se mueva. Un consumidor que descarte filas por marca de tiempo idéntica nunca escribe esos ' +
    'saldos nuevos, y no da error. Para saber si algo cambió, COMPARÁ VALORES. Para paginar usá ' +
    'nextSince + nextAfterId, que es otra cosa: ésos son nuestro reloj (synced_at) y sirven para ' +
    'no releer, no para detectar cambios.',
};

function shape(a: AggRow, p: ProfileRow | null) {
  return {
    userId: a.user_external_id,
    clientId: a.client_id,
    email: a.email,
    username: p?.username ?? null,
    firstName: p?.first_name ?? null,
    lastName: p?.last_name ?? null,
    // Sin normalizar a propósito: la normalización se queda del lado del
    // consumidor, que ya la tiene. Duplicarla es cómo divergen dos
    // implementaciones del mismo teléfono.
    phoneRaw: p?.phone_raw ?? null,
    phoneCountryCode: p?.phone_country_code ?? null,
    country: p?.country ?? null,
    // `country` es el nombre largo ("Colombia"); para agrupar segmentos hay
    // que usar el ISO.
    countryIso: p?.country_iso ?? null,
    language: p?.language ?? null,
    status: p?.status ?? null,
    kycStatus: p?.kyc_status ?? null,
    kycLevel: a.kyc_level,
    userType: p?.user_type ?? null,
    rank: p?.rank ?? null,
    sponsorUsername: p?.sponsor_username ?? null,
    // NO es derivable del username: son dos datos distintos.
    sponsorEmail: p?.sponsor_email ?? null,
    ibProgramName: p?.ib_program_name ?? null,
    ibProgramBrokerName: p?.ib_program_broker_name ?? null,
    registerDate: p?.register_date ?? null,
    enabledWithdrawals: a.enabled_withdrawals,

    // Dinero de la plataforma. Ver nullNotice.
    walletBalance: a.wallet_balance,
    totalDeposits: a.total_deposits,
    depositCount: a.deposit_count,
    lastDepositAt: a.last_deposit_at,
    totalWithdrawals: a.total_withdrawals,

    // "Cuántas abrió". Cuáles OPERAN lo sabe MT5.
    accountsCount: a.accounts_count,
    liveAccountsCount: a.live_accounts_count,
    socialAccountsCount: a.social_accounts_count,

    // El `updatedAt` de Orion. Sirve para saber cuándo cambió el cliente EN EL
    // ORIGEN y para separar lo estable del ruido reciente al comparar — NO
    // para detectar si esta fila cambió. Ver changeDetectionNotice.
    //
    // ── POR QUÉ, EN CONCRETO ────────────────────────────────────────────────
    // Este campo sale de `crm_user_snapshots` y todo lo marcado con `a.` sale
    // de `crm_customer_aggregates`, que es OTRA tabla escrita por OTRO proceso.
    // Medido el 2026-08-26: en las 21.143 filas, sin una sola excepción, el
    // agregado se escribió DESPUÉS del perfil. Así que cualquier cambio en un
    // campo `a.` aterriza con el `sourceUpdatedAt` congelado.
    //
    // Le costó 16 horas de dato viejo a Atlas, y la culpa fue de este contrato:
    // el aviso decía "los agregados de DINERO", y `kycLevel` y
    // `enabledWithdrawals` viven en esa misma tabla pero se leen como campos de
    // perfil. Nombrar la categoría en vez de los campos fue el error.
    sourceUpdatedAt: p?.source_updated_at ?? null,
    // Cuándo lo calculamos NOSOTROS. Distinto de sourceUpdatedAt: uno dice
    // cuándo cambió el dato en el origen, el otro cuándo lo miramos.
    asOf: a.synced_at,
  };
}
