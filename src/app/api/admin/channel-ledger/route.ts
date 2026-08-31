// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/channel-ledger
//
// GET  ?channel_key=&from=&to=        → asientos del libro de un canal.
// GET  ?business_unit_id=&from=&to=   → asientos de TODAS las ubicaciones de
//      una unidad de negocio (libro consolidado).
// POST { action: 'create' | 'update' | 'delete', ... }
//
// Los canales de libro AUTOMÁTICO son SOLO LECTURA acá: su libro lo escribe el
// cron de las 00:00 UTC contra el saldo real del proveedor, y un asiento a mano
// solo podría descuadrarlo. La regla vive en channel-ledger.ts (validateEntry)
// para que la UI y el endpoint no puedan discrepar, y se revalida server-side
// en cada escritura.
//
// La enumeración «(coinsbuy / unipayment)» que estaba acá quedó vieja dos veces
// —entró `fairpay` el 2026-08-31 y `paypros` el mismo día, más las ubicaciones
// on-chain, que ni siquiera tienen clave fija— así que se saca: la lista se
// deriva de BUILTIN_CHANNELS y quien quiera saber cuáles son mira
// `API_LEDGER_CHANNELS`, no este comentario.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth, verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import {
  validateEntry,
  isAutoLedger,
  hasLedger,
  type LedgerEntryInput,
} from '@/lib/channel-ledger';
import { unitLocationShares } from '@/lib/cash-locations';

/**
 * Techos de filas del libro, y por qué son DOS distintos.
 *
 * (2026-08-31, auditoría de finanzas, ítem 19)
 * `ENTRIES_CAP` ya existía como `.limit(5000)` pelado y sin flag. El
 * `priorQuery` de abajo —los asientos ANTERIORES al rango, de donde sale el
 * SALDO DE ARRANQUE— no tenía NINGÚN límite, así que quedaba a merced del
 * `db_max_rows` de PostgREST (1.000 por defecto): pasadas mil filas previas, el
 * front sumaba sólo mil y **todo el libro del rango se mostraba corrido**, con
 * un saldo inicial equivocado y sin ningún error. Un canal con dos años de
 * asiento diario (hasta 5 líneas por día) llega a esas mil filas en siete
 * meses.
 *
 * `PRIOR_CAP` es más alto que `ENTRIES_CAP` a propósito: lo previo es TODA la
 * historia del canal, mientras que las entries son sólo el rango pedido. Y las
 * previas no se renderizan —se suman— así que traerlas es barato.
 */
const ENTRIES_CAP = 5_000;
const PRIOR_CAP = 20_000;

const SELECT_COLS =
  'id, company_id, channel_key, entry_date, kind, source, concept, category, reference, amount, notes, created_by, created_at, updated_at';

/** Un id mal formado revienta en Postgres (22P02); se corta antes con un 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ¿La ubicación tiene direcciones on-chain cargadas? (migración 085)
 *
 * No se puede deducir de la clave: el canal de una wallet on-chain es
 * `wallet_externa` o un `custom_<uuid>` distinto en cada empresa. Pero SÍ lleva
 * libro automático —el cron lo asienta contra el saldo de la cadena cada
 * noche—, así que un asiento a mano encima lo descuadraría igual que en
 * Coinsbuy. Ver `isAutoLedger` en channel-ledger.ts.
 *
 * Ante un error de lectura devuelve `true`: si no sabemos si el libro es
 * automático, no se escribe. Es la misma doctrina de las tres puertas de
 * api-auth.ts:163-171 — ante la duda, lo estricto.
 */
async function channelIsOnchain(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  channelKey: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('channel_configs')
    .select('onchain_wallets')
    .eq('company_id', companyId)
    .eq('channel_key', channelKey)
    .maybeSingle<{ onchain_wallets: unknown }>();
  if (error) return true;
  return Array.isArray(data?.onchain_wallets) && data.onchain_wallets.length > 0;
}

/**
 * Escrituras: mismo criterio que `canAdd` en el cliente (admin o auditor).
 * `hr` pasa el gate genérico de verifyAdminAuth pero no tiene nada que hacer
 * en tesorería, así que se rechaza explícitamente.
 */
async function verifyWriteAccess(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['balances'] });
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'hr') {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente para modificar balances' },
      { status: 403 },
    );
  }
  return auth;
}

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request, { modules: ['balances'] });
  if (auth instanceof NextResponse) return auth;

  const params = request.nextUrl.searchParams;
  const channelKey = params.get('channel_key');
  const businessUnitId = params.get('business_unit_id');
  const from = params.get('from');
  const to = params.get('to');

  const admin = createAdminClient();

  // ── Libro consolidado de una unidad de negocio ─────────────────────────
  // La unidad no guarda asientos propios: son los de sus ubicaciones. Hay que
  // resolver primero qué channel_key le pertenecen, y ese lookup va filtrado
  // por empresa igual que todo lo demás — sin eso, un id de otro tenant
  // devolvería sus canales.
  let unitChannelKeys: string[] | null = null;
  // Parte que le toca a la unidad de cada ubicación (1 = exclusiva). El front
  // la necesita para no mostrar el 100% de una wallet compartida.
  const unitShares: Record<string, number> = {};
  if (businessUnitId) {
    if (!UUID_RE.test(businessUnitId)) {
      return NextResponse.json(
        { success: false, error: 'Unidad de negocio inválida' },
        { status: 400 },
      );
    }
    // Las ubicaciones de la unidad salen de DOS fuentes (migración 071):
    //   · location_business_units — el reparto con porcentaje, y
    //   · channel_configs.business_unit_id — la unidad principal / fallback.
    // Mirar solo la segunda (auditoría 2026-08, A5) hacía que una wallet
    // repartida 50/50 apareciera entera en una unidad y en ninguna otra.
    const [{ data: configs, error: configError }, { data: shareRows, error: shareError }] =
      await Promise.all([
        admin
          .from('channel_configs')
          .select('channel_key, business_unit_id')
          .eq('company_id', auth.companyId),
        admin
          .from('location_business_units')
          .select('channel_key, business_unit_id, share')
          .eq('company_id', auth.companyId),
      ]);

    if (configError) return apiError('admin/channel-ledger', configError, { status: 500 });
    if (shareError) return apiError('admin/channel-ledger', shareError, { status: 500 });

    const shareByKey = unitLocationShares(
      businessUnitId,
      (configs ?? []) as Array<{ channel_key: string; business_unit_id: string | null }>,
      (shareRows ?? []) as Array<{ channel_key: string; business_unit_id: string; share: number }>,
    );

    unitChannelKeys = [...shareByKey.keys()].filter((key) => hasLedger(key));
    for (const key of unitChannelKeys) unitShares[key] = shareByKey.get(key) ?? 1;

    // Unidad sin ubicaciones (o solo con canales que no llevan libro): no es
    // un error, es un libro vacío. Se corta acá para no mandar un `in ()`.
    if (unitChannelKeys.length === 0) {
      return NextResponse.json({
        success: true,
        entries: [],
        priorEntries: [],
        channelKeys: [],
        shares: {},
      });
    }
  }

  let query = admin
    .from('channel_ledger_entries')
    .select(SELECT_COLS)
    .eq('company_id', auth.companyId);

  if (unitChannelKeys) query = query.in('channel_key', unitChannelKeys);
  else if (channelKey) query = query.eq('channel_key', channelKey);
  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);

  // El saldo inicial queda FUERA del filtro `from`: sin él, el saldo corrido
  // del rango arrancaría en cero y todas las filas mostrarían un saldo que
  // no es el del canal. Se trae aparte y se antepone.
  const { data, error } = await query
    .order('entry_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(ENTRIES_CAP);

  if (error) return apiError('admin/channel-ledger', error, { status: 500 });

  const entriesTruncated = (data ?? []).length >= ENTRIES_CAP;

  let opening: unknown[] = [];
  let openingTruncated = false;
  if (from && (channelKey || unitChannelKeys)) {
    let priorQuery = admin
      .from('channel_ledger_entries')
      .select(SELECT_COLS)
      .eq('company_id', auth.companyId)
      .lt('entry_date', from);
    priorQuery = unitChannelKeys
      ? priorQuery.in('channel_key', unitChannelKeys)
      : priorQuery.eq('channel_key', channelKey!);
    // Límite ALTO y EXPLÍCITO. Sin él mandaba el db_max_rows de PostgREST y el
    // saldo de arranque se corría en silencio (ver PRIOR_CAP arriba).
    const { data: op } = await priorQuery
      .order('entry_date', { ascending: true })
      .limit(PRIOR_CAP);
    opening = op ?? [];
    openingTruncated = opening.length >= PRIOR_CAP;
  }

  return NextResponse.json({
    success: true,
    entries: data ?? [],
    // Asientos anteriores al rango, para que el front calcule el saldo de
    // arranque sin tener que traerse el libro entero.
    priorEntries: opening,
    // Ubicaciones de la unidad, incluidas las que no tienen ni un asiento:
    // el desglose por ubicación tiene que poder mostrarlas en cero.
    ...(unitChannelKeys ? { channelKeys: unitChannelKeys, shares: unitShares } : {}),
    /**
     * Se alcanzó el techo de filas. Los dos son graves y de formas distintas:
     *   · `entries`  → faltan asientos del rango: el listado está corto.
     *   · `opening`  → falta HISTORIA previa: el saldo de arranque está mal y
     *                  con él TODO el saldo corrido de la pantalla.
     * Viaja al cliente porque un libro corrido no se distingue de uno correcto
     * mirándolo (§1.2).
     */
    truncated: { entries: entriesTruncated, opening: openingTruncated },
  });
}

export async function POST(request: NextRequest) {
  const auth = await verifyWriteAccess(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  const admin = createAdminClient();

  // ── Alta ───────────────────────────────────────────────────────────────
  if (action === 'create') {
    const input = body as Partial<LedgerEntryInput>;
    const onchain = input.channel_key
      ? await channelIsOnchain(admin, auth.companyId, input.channel_key)
      : false;
    const invalid = validateEntry(input, { onchain });
    if (invalid) {
      return NextResponse.json({ success: false, error: invalid }, { status: 400 });
    }

    const { data, error } = await admin
      .from('channel_ledger_entries')
      .insert({
        company_id: auth.companyId,
        channel_key: input.channel_key,
        entry_date: input.entry_date,
        kind: input.kind,
        source: 'manual',
        concept: input.concept!.trim(),
        category: input.category?.trim() || null,
        reference: input.reference?.trim() || null,
        amount: input.amount,
        notes: input.notes?.trim() || null,
        created_by: auth.userId,
      })
      .select(SELECT_COLS)
      .single();

    if (error) {
      // Índice único parcial: ya hay un saldo inicial para este canal.
      if (error.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'Este canal ya tiene un saldo inicial — editá el existente' },
          { status: 409 },
        );
      }
      return apiError('admin/channel-ledger', error, { status: 500 });
    }

    await admin.from('audit_logs').insert({
      company_id: auth.companyId,
      user_id: auth.userId,
      action: 'create',
      module: 'channel_ledger',
      details: JSON.stringify({
        channel_key: input.channel_key,
        entry_date: input.entry_date,
        kind: input.kind,
        amount: input.amount,
        concept: input.concept,
      }),
    });

    return NextResponse.json({ success: true, entry: data });
  }

  // ── Edición y baja ─────────────────────────────────────────────────────
  // Las dos empiezan igual: hay que releer el asiento para confirmar que es
  // de esta empresa y que no lo escribió el cron. Confiar en el id del body
  // permitiría tocar el libro de otro tenant.
  const id = (body as { id?: string }).id;
  if (action === 'update' || action === 'delete') {
    if (!id) {
      return NextResponse.json({ success: false, error: 'Falta el id del asiento' }, { status: 400 });
    }

    const { data: existing, error: readError } = await admin
      .from('channel_ledger_entries')
      .select('id, company_id, channel_key, source, kind')
      .eq('id', id)
      .maybeSingle();

    if (readError) return apiError('admin/channel-ledger', readError, { status: 500 });
    if (!existing || existing.company_id !== auth.companyId) {
      return NextResponse.json({ success: false, error: 'Asiento no encontrado' }, { status: 404 });
    }
    const existingOnchain = await channelIsOnchain(admin, auth.companyId, existing.channel_key);
    if (existing.source === 'api' || isAutoLedger(existing.channel_key, { onchain: existingOnchain })) {
      return NextResponse.json(
        {
          success: false,
          error: 'Este asiento lo genera la sincronización automática y no se edita a mano',
        },
        { status: 403 },
      );
    }
    if (!hasLedger(existing.channel_key)) {
      return NextResponse.json(
        { success: false, error: 'Este canal no lleva libro' },
        { status: 400 },
      );
    }

    if (action === 'delete') {
      const { error } = await admin.from('channel_ledger_entries').delete().eq('id', id);
      if (error) return apiError('admin/channel-ledger', error, { status: 500 });

      await admin.from('audit_logs').insert({
        company_id: auth.companyId,
        user_id: auth.userId,
        action: 'delete',
        module: 'channel_ledger',
        details: JSON.stringify({ id, channel_key: existing.channel_key }),
      });
      return NextResponse.json({ success: true });
    }

    const input = body as Partial<LedgerEntryInput>;
    // El saldo inicial conserva su `kind`: cambiarlo a 'out' lo volvería un
    // egreso y dejaría al canal sin punto de partida.
    const kind = existing.kind === 'opening' ? 'opening' : input.kind;
    const invalid = validateEntry(
      { ...input, kind, channel_key: existing.channel_key },
      { onchain: existingOnchain },
    );
    if (invalid) {
      return NextResponse.json({ success: false, error: invalid }, { status: 400 });
    }

    const { data, error } = await admin
      .from('channel_ledger_entries')
      .update({
        entry_date: input.entry_date,
        kind,
        concept: input.concept!.trim(),
        category: input.category?.trim() || null,
        reference: input.reference?.trim() || null,
        amount: input.amount,
        notes: input.notes?.trim() || null,
      })
      .eq('id', id)
      .select(SELECT_COLS)
      .single();

    if (error) return apiError('admin/channel-ledger', error, { status: 500 });

    await admin.from('audit_logs').insert({
      company_id: auth.companyId,
      user_id: auth.userId,
      action: 'update',
      module: 'channel_ledger',
      details: JSON.stringify({ id, channel_key: existing.channel_key, amount: input.amount }),
    });

    return NextResponse.json({ success: true, entry: data });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
