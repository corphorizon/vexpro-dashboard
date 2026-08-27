import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { monthToFirstDay } from '@/lib/hr/net-deposit';
import {
  isDealType,
  emptyIbNumbers,
  type IbNegotiationRow,
  type IbNegotiationPackage,
  type IbNumbers,
} from '@/lib/hr/ib-negotiations';

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/ib-negotiations — negociaciones con IBs del CRM.
//
// Kevin, 2026-08-27: «me gustaría crear en esa sección algo para también tener
// negociaciones de IB por aparte, normalmente son negociaciones de PNL o Net
// Deposit, necesitaría tener la info completa de ellos, el net deposit de ellos
// y su red, el PNL, la cantidad de lotes que se les pagaron y cuánto se les
// pagó».
//
// GET  ?month=YYYY-MM                 → las negociaciones con TODO el paquete
// GET  ?q=texto                       → buscador de IB contra crm_user_snapshots
// GET  ?network=username&month=YYYY-MM → los miembros de la red que movieron
// POST { action: 'create' | 'update' | 'close' }
//
// ── ESTO NO TOCA `commercial_negotiations` ────────────────────────────────
// Aquella tabla es de PERFILES COMERCIALES (FK a commercial_profiles, 126
// filas). Un IB es un cliente del CRM que refiere gente y casi nunca tiene
// perfil comercial: sólo 114 de los 1.793 sponsors distintos lo son. Son dos
// cosas distintas y Kevin las pidió separadas. Ver migración 099.
//
// ── DE DÓNDE SALE CADA NÚMERO ─────────────────────────────────────────────
// · Perfil del IB          → crm_user_snapshots (espejo del CRM)
// · Lotes/comisión/PNL     → crm_ib_reward_daily, filtrando por ib_user_id.
//   El `ib_user_id` de los premios ES el `user_external_id` del snapshot:
//   verificado sobre Vex Pro el 2026-08-27, 37.166 de 37.166 filas y 702 de
//   702 IB matchean, el 100% de los 777.515,99 USD de comisión. Sin fallback
//   porque no hace falta ninguno.
// · Desglose forex/sint.   → crm_ib_reward_symbol_daily, que sólo existe desde
//   el 2026-08-13 (el bróker purga la colección de origen a los quince días).
//   Los meses viejos NO tienen desglose y NUNCA lo van a tener: viajan como
//   null, no como cero, y la pantalla escribe "sin dato".
// · Net deposit propio y de la red → RPC crm_ib_network_stats (migración 099),
//   que BAJA por la cadena de sponsors — al revés de la 097, que sube.
//
// ── LO QUE SE LE PAGÓ AL IB YA INCLUYE A SU RED ───────────────────────────
// Los premios de `crm_ib_reward_daily` son por las operaciones de TODA su
// estructura: por eso la comisión y los lotes NO se rollan sumando los de los
// sub-IB. Sumarlos contaría dos veces lo mismo (un sub-IB cobra por la misma
// operación en su propio nivel). El único número que sí se rolla es el net
// deposit, y por eso va separado en dos columnas: propio y de la red.
//
// ── EL PNL ES ATRIBUIDO ───────────────────────────────────────────────────
// `ibrewards` repite el pnl de cada operación una vez por nivel de IB que
// cobra: la suma cruda del 2026-08-25 daba 1.942.516,76 y deduplicando por
// operación 393.366,44 (4,9 niveles de promedio). Es legítimo POR IB y no es
// el PNL de la empresa. Explicado largo en src/lib/hr/ib-production.ts.
//
// Lectura la decide el módulo (`hr`), escritura el rol (HR_ROLES) — mismo gate
// que las rutas vecinas de RRHH.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 1000;

/** `2026-07` o `2026-07-01`; cualquier otra cosa se rechaza. */
function parseMonth(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return monthToFirstDay(raw);
}

function daysInMonth(firstDay: string): number {
  const [y, m] = firstDay.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** numeric de Postgres llega como string por JSON. */
function n(v: number | string | null | undefined): number {
  return Number(v) || 0;
}

const NEG_COLS =
  'id, user_external_id, ib_email, ib_username, deal_type, terms, pct, target_amount, ' +
  'status, starts_on, ends_on, notes, created_by_name, created_at, updated_at';

const SNAP_COLS =
  'user_external_id, username, email, first_name, last_name, phone_raw, phone_country_code, ' +
  'country, country_iso, status, kyc_status, user_type, rank, register_date, ' +
  'sponsor_username, sponsor_email, ib_program_name';

type SnapshotRow = {
  user_external_id: string;
  username: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_raw: string | null;
  phone_country_code: string | null;
  country: string | null;
  country_iso: string | null;
  status: string | null;
  kyc_status: string | null;
  user_type: string | null;
  rank: string | null;
  register_date: string | null;
  sponsor_username: string | null;
  sponsor_email: string | null;
  ib_program_name: string | null;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['hr'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const companyId = auth.companyId;
    const params = new URL(request.url).searchParams;

    // ── Modo buscador: dar de alta una negociación empieza por encontrar al IB
    // Se busca por email o username porque son los dos identificadores que
    // alguien tiene a mano cuando le llega un IB por WhatsApp. El `q` se
    // normaliza a minúsculas: el CRM guarda los correos como los tipeó el
    // usuario y buscar "Ana.Garcia@…" en crudo no encontraba nada.
    const q = params.get('q');
    if (q !== null) {
      const needle = q.trim().toLowerCase();
      if (needle.length < 3) {
        return NextResponse.json({ results: [] });
      }
      const safe = needle.replace(/[%_,()]/g, ' ').trim();
      if (!safe) return NextResponse.json({ results: [] });
      const { data, error } = await admin
        .from('crm_user_snapshots')
        .select(SNAP_COLS)
        .eq('company_id', companyId)
        .or(`username.ilike.%${safe}%,email.ilike.%${safe}%`)
        .order('username', { ascending: true })
        .range(0, 24);
      if (error) return apiError('admin/ib-negotiations search', error, { status: 500, withSuccessFlag: false });
      return NextResponse.json({ results: data ?? [] });
    }

    // ── Modo detalle: los miembros de la red de UN IB ─────────────────────
    const network = params.get('network');
    if (network !== null) {
      const month = parseMonth(params.get('month'));
      if (!month) return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
      // Guard cross-tenant: sólo se puede pedir la red de un IB con el que ESTA
      // empresa tiene una negociación. Sin esto, el admin de la empresa A
      // mandaba un username cualquiera y se llevaba la red de un IB ajeno —
      // el RPC filtra por company_id, pero el company_id lo elige esta línea.
      const { data: owned } = await admin
        .from('ib_negotiations')
        .select('id')
        .eq('company_id', companyId)
        .eq('ib_username', network)
        .limit(1)
        .maybeSingle();
      if (!owned) {
        return NextResponse.json({ error: 'No hay negociación con ese IB en tu empresa' }, { status: 403 });
      }
      const { data, error } = await admin.rpc('crm_ib_network_members', {
        p_company_id: companyId,
        p_username: network,
        p_month: month,
        p_limit: 50,
      });
      if (error) return apiError('admin/ib-negotiations network', error, { status: 500, withSuccessFlag: false });
      return NextResponse.json({ month, members: data ?? [] });
    }

    // ── Modo lista: las negociaciones con todo el paquete del mes ─────────
    const month = parseMonth(params.get('month'));
    if (!month) {
      return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
    }

    // `.range()` + `.order()` y no un select pelado: PostgREST corta en 1.000
    // sin avisar. Hoy son pocas filas, pero el día que no lo sean el bug sería
    // "faltan negociaciones" y nadie lo relacionaría con esta línea.
    const negotiations: IbNegotiationRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('ib_negotiations')
        .select(NEG_COLS)
        .eq('company_id', companyId)
        .order('status', { ascending: true })   // 'active' antes que 'closed'
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true })       // desempate estable entre páginas
        .range(from, from + PAGE - 1);
      if (error) return apiError('admin/ib-negotiations GET', error, { status: 500, withSuccessFlag: false });
      negotiations.push(...((data ?? []) as unknown as IbNegotiationRow[]));
      if (!data || data.length < PAGE) break;
    }

    if (negotiations.length === 0) {
      return NextResponse.json({
        month,
        currency: 'USD',
        packages: [],
        symbolCoverage: coverageEmpty(month),
      });
    }

    const ids = [...new Set(negotiations.map((x) => x.user_external_id))];
    const usernames = [...new Set(
      negotiations.map((x) => (x.ib_username ?? '').trim().toLowerCase()).filter(Boolean),
    )];

    // ── Perfil completo de cada IB ────────────────────────────────────────
    const snapshots = new Map<string, SnapshotRow>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await admin
        .from('crm_user_snapshots')
        .select(SNAP_COLS)
        .eq('company_id', companyId)
        .in('user_external_id', ids.slice(i, i + 200));
      if (error) return apiError('admin/ib-negotiations snapshots', error, { status: 500, withSuccessFlag: false });
      for (const s of (data ?? []) as unknown as SnapshotRow[]) snapshots.set(s.user_external_id, s);
    }

    // ── Producción del mes: lotes, comisión, PNL, pagos ───────────────────
    // Un mes son ~5.000 filas en el espejo diario y acá se piden sólo las de
    // los IB negociados, así que entra de sobra en una página.
    const finMes = `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, '0')}`;
    const numbers = new Map<string, IbNumbers>();

    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await admin
        .from('crm_ib_reward_daily')
        .select('ib_user_id, lots, commission, pnl, rewards_count')
        .eq('company_id', companyId)
        .in('ib_user_id', chunk)
        .gte('day', month)
        .lte('day', finMes)
        .order('day', { ascending: true })
        .range(0, 9999);
      if (error) return apiError('admin/ib-negotiations rewards', error, { status: 500, withSuccessFlag: false });
      for (const r of data ?? []) {
        const id = String(r.ib_user_id);
        const acc = numbers.get(id) ?? emptyIbNumbers();
        acc.lots += n(r.lots);
        acc.commission += n(r.commission);
        acc.pnl += n(r.pnl);
        acc.rewards += n(r.rewards_count);
        acc.activeDays += 1;
        numbers.set(id, acc);
      }
    }

    // ── Desglose forex / sintéticos ───────────────────────────────────────
    // Se acumula sobre `null`: si el mes no tiene NINGUNA fila de desglose para
    // ese IB, las cuatro columnas quedan en null y la pantalla dice "sin dato".
    // Arrancarlas en cero haría indistinguible "no lo sabemos" de "no operó
    // sintéticos" — el mismo error que la migración 098 existe para no cometer.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await admin
        .from('crm_ib_reward_symbol_daily')
        .select('ib_user_id, asset_class, lots, commission, rewards_count')
        .eq('company_id', companyId)
        .in('ib_user_id', chunk)
        .gte('day', month)
        .lte('day', finMes)
        .order('day', { ascending: true })
        .range(0, 9999);
      if (error) return apiError('admin/ib-negotiations symbols', error, { status: 500, withSuccessFlag: false });
      for (const r of data ?? []) {
        const id = String(r.ib_user_id);
        const acc = numbers.get(id) ?? emptyIbNumbers();
        if (r.asset_class === 'forex') {
          acc.forexLots = (acc.forexLots ?? 0) + n(r.lots);
          acc.forexCommission = (acc.forexCommission ?? 0) + n(r.commission);
        } else {
          acc.syntheticLots = (acc.syntheticLots ?? 0) + n(r.lots);
          acc.syntheticCommission = (acc.syntheticCommission ?? 0) + n(r.commission);
        }
        numbers.set(id, acc);
      }
    }

    // ── Net deposit propio y de la red ────────────────────────────────────
    // Una sola llamada para TODOS los IB negociados: el RPC recorre el árbol una
    // vez. Medido sobre Vex Pro con los 8 IB más grandes (39.786 filas de
    // subárbol, hasta 17 niveles): 0,46 s en caliente, 8,1 s la primera vez con
    // la caché fría. Una llamada por fila hubiera sido ocho recorridos.
    type NetRow = {
      root_username: string;
      network_size: number | string;
      network_depth: number | string;
      network_net: number | string;
      network_movers: number | string;
      own_net: number | string;
    };
    const netByUser = new Map<string, NetRow>();
    if (usernames.length > 0) {
      const { data, error } = await admin.rpc('crm_ib_network_stats', {
        p_company_id: companyId,
        p_usernames: usernames,
        p_month: month,
      });
      if (error) return apiError('admin/ib-negotiations network stats', error, { status: 500, withSuccessFlag: false });
      for (const r of (data ?? []) as NetRow[]) netByUser.set(r.root_username, r);
    }

    // ── Cobertura del desglose por símbolo ────────────────────────────────
    // Se pregunta al espejo y no se deduce de los números: cero filas puede ser
    // "el mes no está cubierto" o "nadie operó", y sólo esta consulta las
    // distingue. Igual que /api/admin/hr-ib-production-rollup.
    const { data: dias, error: diasError } = await admin
      .from('crm_ib_reward_symbol_daily')
      .select('day')
      .eq('company_id', companyId)
      .gte('day', month)
      .lte('day', finMes)
      .order('day', { ascending: true })
      .range(0, 999);
    if (diasError) return apiError('admin/ib-negotiations dias', diasError, { status: 500, withSuccessFlag: false });
    const diasCubiertos = [...new Set((dias ?? []).map((d) => String(d.day).slice(0, 10)))].sort();

    const packages: IbNegotiationPackage[] = negotiations.map((neg) => {
      const un = (neg.ib_username ?? '').trim().toLowerCase();
      const net = netByUser.get(un);
      return {
        negotiation: neg,
        profile: snapshots.get(neg.user_external_id) ?? null,
        production: numbers.get(neg.user_external_id) ?? emptyIbNumbers(),
        network: net
          ? {
              size: n(net.network_size),
              depth: n(net.network_depth),
              net: n(net.network_net),
              movers: n(net.network_movers),
              ownNet: n(net.own_net),
            }
          // null y no ceros: sin username congelado (o con un IB que ya no está
          // en el espejo) no sabemos nada de su red. Ver el comentario de arriba.
          : null,
      };
    });

    return NextResponse.json({
      month,
      currency: 'USD',
      packages,
      symbolCoverage: {
        days: diasCubiertos.length,
        daysInMonth: daysInMonth(month),
        from: diasCubiertos[0] ?? null,
        to: diasCubiertos[diasCubiertos.length - 1] ?? null,
      },
    });
  } catch (err) {
    return apiError('admin/ib-negotiations GET', err, { status: 500, withSuccessFlag: false });
  }
}

function coverageEmpty(month: string) {
  return { days: 0, daysInMonth: daysInMonth(month), from: null, to: null };
}

/** `null` si no vino, número si vino válido, `undefined` si vino basura. */
function optionalNumber(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

function optionalText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** `YYYY-MM-DD` o null. `undefined` = venía algo que no es una fecha. */
function optionalDate(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['hr'] });
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const admin = createAdminClient();
    const companyId = auth.companyId;

    if (body.action === 'create') {
      const userExternalId = optionalText(body.user_external_id);
      if (!userExternalId) return NextResponse.json({ error: 'user_external_id requerido' }, { status: 400 });
      if (!isDealType(body.deal_type)) return NextResponse.json({ error: 'deal_type inválido' }, { status: 400 });

      // El IB tiene que existir EN EL ESPEJO DE ESTA EMPRESA. El cliente admin
      // bypassea RLS, así que sin esta comprobación un admin de la empresa A
      // podía abrir una negociación contra un IB de la empresa B mandando su
      // id — y después leerle la red y la producción por el GET.
      const { data: ib, error: ibError } = await admin
        .from('crm_user_snapshots')
        .select('user_external_id, username, email')
        .eq('company_id', companyId)
        .eq('user_external_id', userExternalId)
        .maybeSingle();
      if (ibError) return apiError('admin/ib-negotiations create lookup', ibError, { status: 500, withSuccessFlag: false });
      if (!ib) return NextResponse.json({ error: 'Ese IB no existe en el CRM de tu empresa' }, { status: 403 });

      const pct = optionalNumber(body.pct);
      if (pct === undefined) return NextResponse.json({ error: 'pct inválido' }, { status: 400 });
      const target = optionalNumber(body.target_amount);
      if (target === undefined) return NextResponse.json({ error: 'target_amount inválido' }, { status: 400 });
      const startsOn = optionalDate(body.starts_on);
      if (startsOn === undefined) return NextResponse.json({ error: 'starts_on inválido' }, { status: 400 });
      const endsOn = optionalDate(body.ends_on);
      if (endsOn === undefined) return NextResponse.json({ error: 'ends_on inválido' }, { status: 400 });

      const { data, error } = await admin
        .from('ib_negotiations')
        .insert({
          company_id: companyId,
          user_external_id: userExternalId,
          // Congelados al alta: con quién se firmó, aunque el CRM se los cambie.
          // Se toman del espejo y no del body por la misma razón que el guard de
          // arriba — el cliente no decide con quién se firmó.
          ib_email: ib.email ?? null,
          ib_username: (ib.username ?? '').trim().toLowerCase() || null,
          deal_type: body.deal_type,
          terms: optionalText(body.terms),
          pct,
          target_amount: target,
          starts_on: startsOn,
          ends_on: endsOn,
          notes: optionalText(body.notes),
          created_by_name: auth.name || auth.email || null,
        })
        .select(NEG_COLS)
        .single();

      if (error) {
        // 23505 = ya hay una activa de ese tipo para ese IB. No es un error de
        // servidor: es la regla de negocio de la migración 099, y el mensaje
        // tiene que decir qué hacer (cerrar la vigente) y no "duplicate key".
        if ((error as { code?: string }).code === '23505') {
          return NextResponse.json(
            { error: 'Ya hay una negociación activa de ese tipo con este IB. Cerrala antes de abrir otra.' },
            { status: 409 },
          );
        }
        return apiError('admin/ib-negotiations create', error, { status: 400, withSuccessFlag: false });
      }
      return NextResponse.json({ success: true, negotiation: data });
    }

    if (body.action === 'update' || body.action === 'close') {
      if (!body.id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

      const fields: Record<string, unknown> = {};
      if (body.action === 'close') {
        fields.status = 'closed';
        // Cerrar sin fecha de fin deja una negociación que "terminó alguna vez":
        // se le pone hoy si no tenía, y se respeta la que ya estuviera cargada.
        if (optionalDate(body.ends_on)) fields.ends_on = body.ends_on;
      } else {
        if (body.deal_type !== undefined) {
          if (!isDealType(body.deal_type)) return NextResponse.json({ error: 'deal_type inválido' }, { status: 400 });
          fields.deal_type = body.deal_type;
        }
        if (body.terms !== undefined) fields.terms = optionalText(body.terms);
        if (body.notes !== undefined) fields.notes = optionalText(body.notes);
        if (body.pct !== undefined) {
          const pct = optionalNumber(body.pct);
          if (pct === undefined) return NextResponse.json({ error: 'pct inválido' }, { status: 400 });
          fields.pct = pct;
        }
        if (body.target_amount !== undefined) {
          const target = optionalNumber(body.target_amount);
          if (target === undefined) return NextResponse.json({ error: 'target_amount inválido' }, { status: 400 });
          fields.target_amount = target;
        }
        if (body.starts_on !== undefined) {
          const d = optionalDate(body.starts_on);
          if (d === undefined) return NextResponse.json({ error: 'starts_on inválido' }, { status: 400 });
          fields.starts_on = d;
        }
        if (body.ends_on !== undefined) {
          const d = optionalDate(body.ends_on);
          if (d === undefined) return NextResponse.json({ error: 'ends_on inválido' }, { status: 400 });
          fields.ends_on = d;
        }
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'closed') {
            return NextResponse.json({ error: 'status inválido' }, { status: 400 });
          }
          fields.status = body.status;
        }
      }

      if (Object.keys(fields).length === 0) {
        return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
      }

      // `.eq('company_id')` no es decorativo: sin él, un id de otra empresa se
      // actualizaría igual porque el cliente admin bypassea RLS.
      const { data, error } = await admin
        .from('ib_negotiations')
        .update(fields)
        .eq('id', body.id)
        .eq('company_id', companyId)
        .select(NEG_COLS);
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          return NextResponse.json(
            { error: 'Ya hay una negociación activa de ese tipo con este IB.' },
            { status: 409 },
          );
        }
        return apiError('admin/ib-negotiations update', error, { status: 400, withSuccessFlag: false });
      }
      if (!data || data.length === 0) {
        return NextResponse.json({ error: 'No se encontró la negociación en esta empresa' }, { status: 404 });
      }
      return NextResponse.json({ success: true, negotiation: data[0] });
    }

    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (err) {
    return apiError('admin/ib-negotiations POST', err, { status: 500, withSuccessFlag: false });
  }
}
