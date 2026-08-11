// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/channel-configs
//
// GET                               → list all channel_configs rows for the
//                                     caller's company (cualquier miembro;
//                                     superadmin debe pasar ?company_id=…).
//                                     Cada fila trae su `unit_shares` (el
//                                     reparto de la migración 071).
// POST { action:'upsert', ... }     → create or update one channel_config.
// POST { action:'delete', key }     → delete a custom channel (is_custom=true).
//                                     Built-ins can't be deleted.
// POST { action:'create_custom',
//        label, initialBalance? }   → append a new custom channel.
//
// All writes are admin-gated and include an audit_logs insert.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifyAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  newCustomChannelKey,
  BUILTIN_CHANNELS,
  type ChannelType,
} from '@/lib/channel-configs';
import { apiError } from '@/lib/api-error';
import { DEFAULT_LOCATION_TYPE, isLocationType, type UnitShare } from '@/lib/cash-locations';
import { AUTO_CATEGORIES } from '@/lib/channel-ledger';
import type { ChannelConfigRow } from '@/lib/channel-configs';

const BUILTIN_KEYS = new Set(BUILTIN_CHANNELS.map((c) => c.key));

const CONFIG_COLUMNS =
  'id, channel_key, custom_label, channel_type, is_visible, is_custom, sort_order, location_type, business_unit_id, holder';

/**
 * El admin client saltea RLS, así que aceptar un business_unit_id del body sin
 * verificar de qué empresa es permitiría colgar una ubicación propia de la
 * unidad de otro inquilino (IDOR). Devuelve la unidad validada o null.
 */
async function belongsToCompany(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  unitId: string,
): Promise<boolean> {
  const { data } = await admin
    .from('business_units')
    .select('id')
    .eq('id', unitId)
    .eq('company_id', companyId)
    .maybeSingle();
  return Boolean(data);
}

async function resolveCompanyAndAuth(
  explicitCompanyId: string | null,
): Promise<{ companyId: string; userId: string } | NextResponse> {
  if (explicitCompanyId) {
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    return { companyId: explicitCompanyId, userId: sa.userId };
  }
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden configurar canales' },
      { status: 403 },
    );
  }
  return { companyId: auth.companyId, userId: auth.userId };
}

export async function GET(request: NextRequest) {
  // Lectura abierta a cualquier miembro de la empresa. El gate admin-estricto
  // que había acá no protegía nada (la RLS ya deja leer la tabla al tenant) y
  // en cambio degradaba la UI: sin estas filas el auditor veía las claves
  // crudas del canal en vez de su etiqueta. Las escrituras (POST) siguen
  // siendo admin-only vía resolveCompanyAndAuth.
  const auth = await verifyAuth(request);
  if (auth instanceof NextResponse) return auth;

  const admin = createAdminClient();
  // El reparto viaja PEGADO a la configuración, no en un endpoint aparte.
  // Cuando había que pedirlo por separado, cada pantalla nueva se olvidaba de
  // hacerlo y atribuía la ubicación entera a su unidad principal: el reporte de
  // empresa mostraba una wallet 60/40 como 100% de una sola unidad mientras
  // /balances la repartía bien (auditoría 2026-08, B1/C6). Si el contrato lo
  // incluye siempre, ningún consumidor puede omitirlo.
  const [configs, shares] = await Promise.all([
    admin
      .from('channel_configs')
      .select(CONFIG_COLUMNS)
      .eq('company_id', auth.companyId)
      .order('sort_order', { ascending: true }),
    admin
      .from('location_business_units')
      .select('channel_key, business_unit_id, share')
      .eq('company_id', auth.companyId),
  ]);

  if (configs.error) {
    return apiError('admin/channel-configs', configs.error, { status: 500 });
  }
  if (shares.error) {
    return apiError('admin/channel-configs shares', shares.error, { status: 500 });
  }

  const sharesByKey = new Map<string, UnitShare[]>();
  for (const row of shares.data ?? []) {
    if (!row?.channel_key || !row.business_unit_id) continue;
    const entry: UnitShare = {
      business_unit_id: row.business_unit_id,
      share: Number(row.share) || 0,
    };
    const arr = sharesByKey.get(row.channel_key);
    if (arr) arr.push(entry);
    else sharesByKey.set(row.channel_key, [entry]);
  }

  // `unit_shares: []` y no `null` cuando no hay reparto: así el consumidor
  // distingue "no hay filas" (manda business_unit_id) de "no me lo mandaron".
  const rows: ChannelConfigRow[] = (configs.data ?? []).map((r) => ({
    ...(r as ChannelConfigRow),
    unit_shares: sharesByKey.get(r.channel_key) ?? [],
  }));

  return NextResponse.json({ success: true, rows });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const explicit =
    request.nextUrl.searchParams.get('company_id') ||
    (body as { company_id?: string }).company_id ||
    null;
  const ctx = await resolveCompanyAndAuth(explicit);
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const action = (body as { action?: string }).action;

  if (action === 'upsert') {
    const {
      channel_key,
      custom_label,
      is_visible,
      sort_order,
      location_type,
      business_unit_id,
      holder,
    } = body as {
      channel_key?: string;
      custom_label?: string | null;
      is_visible?: boolean;
      sort_order?: number;
      location_type?: string;
      business_unit_id?: string | null;
      holder?: string | null;
    };
    if (!channel_key || typeof channel_key !== 'string') {
      return NextResponse.json({ success: false, error: 'channel_key requerido' }, { status: 400 });
    }
    const isBuiltin = BUILTIN_KEYS.has(channel_key);
    // For built-ins we lock channel_type to the hardcoded value and don't
    // allow renaming API-sourced channels (coinsbuy / unipayment) because
    // their label comes from the provider itself.
    const builtin = BUILTIN_CHANNELS.find((c) => c.key === channel_key);
    const apiChannel = builtin && builtin.type === 'auto' && ['coinsbuy', 'unipayment'].includes(channel_key);

    const payload: Record<string, unknown> = {
      company_id: ctx.companyId,
      channel_key,
      updated_at: new Date().toISOString(),
    };
    // `is_visible` OMITIDO ≠ `is_visible: true`. Mismo criterio que
    // custom_label: solo se escribe lo que vino en el body. Forzarlo a true
    // hacía que RENOMBRAR un canal archivado lo DES-ARCHIVARA — el modal manda
    // solo `custom_label` y el canal reaparecía en /balances (y en el total)
    // sin que nadie lo pidiera.
    //
    // OJO con el insert: el upsert puede terminar insertando la fila y en ese
    // caso la columna toma su default en la DB (true), que es justo lo que
    // corresponde para un canal que hasta ahora no tenía configuración.
    if (typeof is_visible === 'boolean') payload.is_visible = is_visible;
    // `custom_label` OMITIDO ≠ `custom_label: null`. Antes cualquier upsert
    // que no lo mandara (el toggle de visibilidad del modal, y desde hoy el
    // guardado de tipo/holder de la tarjeta de ubicaciones) lo pisaba con
    // null: un canal personalizado perdía su nombre y pasaba a mostrarse
    // como `custom_<uuid>`. Mismo criterio que location_type/holder.
    if (!apiChannel && custom_label !== undefined) {
      payload.custom_label = typeof custom_label === 'string' ? custom_label.trim() || null : null;
    }
    if (typeof sort_order === 'number') payload.sort_order = sort_order;
    if (isBuiltin) {
      payload.channel_type = builtin!.type;
      payload.is_custom = false;
    } else {
      // Una clave que no es built-in ES un canal personalizado. Fijarlo acá
      // deja el flag coherente aunque el upsert termine insertando (y sin él
      // la acción `delete`, que filtra por is_custom=true, no lo encontraría).
      payload.is_custom = true;
    }

    // Dónde está la plata (migración 070). Los tres campos son opcionales:
    // omitirlos deja intacto lo que ya estaba, para que el toggle de
    // visibilidad no borre la clasificación de la ubicación.
    if (location_type !== undefined) {
      if (!isLocationType(location_type)) {
        return NextResponse.json(
          { success: false, error: 'Tipo de ubicación no válido' },
          { status: 400 },
        );
      }
      payload.location_type = location_type;
    }
    if (business_unit_id !== undefined) {
      if (business_unit_id === null || business_unit_id === '') {
        payload.business_unit_id = null;
      } else if (await belongsToCompany(admin, ctx.companyId, business_unit_id)) {
        payload.business_unit_id = business_unit_id;
      } else {
        return NextResponse.json(
          { success: false, error: 'La unidad de negocio no existe en esta empresa' },
          { status: 400 },
        );
      }
    }
    if (holder !== undefined) {
      payload.holder = typeof holder === 'string' ? holder.trim() || null : null;
    }

    const { error } = await admin
      .from('channel_configs')
      .upsert(payload, { onConflict: 'company_id,channel_key' });
    if (error) {
      return apiError('admin/channel-configs', error, { status: 500 });
    }
    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'update',
      module: 'balances_channel_config',
      details: JSON.stringify({
        channel_key,
        is_visible,
        custom_label,
        location_type: payload.location_type,
        business_unit_id: payload.business_unit_id,
        holder: payload.holder,
      }),
    });
    return NextResponse.json({ success: true });
  }

  if (action === 'create_custom') {
    const { label, initial_balance, as_of, location_type, business_unit_id, holder } = body as {
      label?: string;
      initial_balance?: number;
      as_of?: string;
      location_type?: string;
      business_unit_id?: string | null;
      holder?: string | null;
    };
    const clean = (label ?? '').trim();
    if (!clean) {
      return NextResponse.json({ success: false, error: 'El nombre del canal es requerido' }, { status: 400 });
    }
    if (location_type !== undefined && !isLocationType(location_type)) {
      return NextResponse.json({ success: false, error: 'Tipo de ubicación no válido' }, { status: 400 });
    }
    // Sin esto no habría forma de dar de alta un "Préstamo a X": el alta
    // creaba el lugar y el tipo había que ponérselo después, en otra pantalla.
    let unitId: string | null = null;
    if (business_unit_id) {
      if (!(await belongsToCompany(admin, ctx.companyId, business_unit_id))) {
        return NextResponse.json(
          { success: false, error: 'La unidad de negocio no existe en esta empresa' },
          { status: 400 },
        );
      }
      unitId = business_unit_id;
    }
    const channel_key = newCustomChannelKey();
    const channel_type: ChannelType = 'manual';

    const { error } = await admin.from('channel_configs').insert({
      company_id: ctx.companyId,
      channel_key,
      custom_label: clean,
      channel_type,
      is_visible: true,
      is_custom: true,
      sort_order: 200,
      location_type: location_type ?? DEFAULT_LOCATION_TYPE,
      business_unit_id: unitId,
      holder: typeof holder === 'string' ? holder.trim() || null : null,
    });
    if (error) {
      return apiError('admin/channel-configs', error, { status: 500 });
    }

    // Saldo inicial.
    //
    // EL SALDO INICIAL ES UN ASIENTO DE APERTURA, NO UN SNAPSHOT. Antes esto
    // escribía SOLO una fila en channel_balances, pero /balances (y el reporte,
    // y el total consolidado) prefieren el LIBRO: en cuanto alguien cargaba el
    // primer asiento de $50, el canal pasaba a valer $50 y los $1.000 de
    // apertura se evaporaban. Se asienta en el libro —que es la representación
    // correcta— y el snapshot queda como respaldo para las pantallas que
    // todavía leen la foto diaria.
    const todayISO = () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    if (typeof initial_balance === 'number' && Number.isFinite(initial_balance) && initial_balance !== 0) {
      const entryDate = as_of && /^\d{4}-\d{2}-\d{2}$/.test(as_of) ? as_of : todayISO();
      await admin.from('channel_balances').upsert(
        {
          company_id: ctx.companyId,
          snapshot_date: entryDate,
          channel_key,
          amount: initial_balance,
          source: 'manual',
        },
        { onConflict: 'company_id,snapshot_date,channel_key' },
      );

      // `amount` en el libro es siempre positivo: el signo lo da `kind`. Una
      // apertura en negativo (raro pero cargable) se asienta como egreso, que
      // es la única forma de representarla sin violar el check de la tabla.
      const openingRow = {
        company_id: ctx.companyId,
        channel_key,
        entry_date: entryDate,
        kind: initial_balance > 0 ? ('opening' as const) : ('out' as const),
        source: 'manual' as const,
        concept: 'Saldo inicial',
        category: AUTO_CATEGORIES.opening,
        amount: Math.abs(initial_balance),
        created_by: ctx.userId,
      };
      const { error: openingError } = await admin
        .from('channel_ledger_entries')
        .insert(openingRow);
      // 23505 = el índice único channel_ledger_entries_one_opening
      // (company_id, channel_key) WHERE kind='opening'. Ya hay apertura para
      // esta clave: se actualiza en vez de duplicar.
      if (openingError?.code === '23505') {
        await admin
          .from('channel_ledger_entries')
          .update({
            entry_date: openingRow.entry_date,
            concept: openingRow.concept,
            category: openingRow.category,
            amount: openingRow.amount,
          })
          .eq('company_id', ctx.companyId)
          .eq('channel_key', channel_key)
          .eq('kind', 'opening');
      } else if (openingError) {
        return apiError('admin/channel-configs opening', openingError, { status: 500 });
      }
    }

    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'create',
      module: 'balances_channel_config',
      details: JSON.stringify({ channel_key, label: clean, initial_balance, location_type, business_unit_id: unitId, holder }),
    });
    return NextResponse.json({ success: true, channel_key });
  }

  if (action === 'delete') {
    const { channel_key } = body as { channel_key?: string };
    if (!channel_key) {
      return NextResponse.json({ success: false, error: 'channel_key requerido' }, { status: 400 });
    }
    if (BUILTIN_KEYS.has(channel_key)) {
      return NextResponse.json(
        { success: false, error: 'Los canales predefinidos no se pueden eliminar — ocúltalos con el toggle' },
        { status: 400 },
      );
    }
    const { error } = await admin
      .from('channel_configs')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('channel_key', channel_key)
      .eq('is_custom', true);
    if (error) {
      return apiError('admin/channel-configs', error, { status: 500 });
    }
    // Also clean up any stored balances for this key so they don't linger.
    await admin
      .from('channel_balances')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('channel_key', channel_key);
    // El reparto por unidad no tiene FK contra channel_configs (la clave es
    // texto libre), así que sin este borrado quedarían filas huérfanas que
    // reaparecerían si alguien reusa la misma clave.
    await admin
      .from('location_business_units')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('channel_key', channel_key);

    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'delete',
      module: 'balances_channel_config',
      details: JSON.stringify({ channel_key }),
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
