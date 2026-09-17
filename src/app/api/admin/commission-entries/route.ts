import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { bucketDePnl, esLineaNdDeMasterIb } from '@/lib/hr/pnl-buckets';

// POST — upsert commission entries { period_id, head_id, entries[] }
// Uses individual upserts to avoid accidentally deleting entries not in the batch
//
// ── `pnl_bucket_cleanup` (2026-09-16) ──────────────────────────────────────
// Opción explícita del payload que /comisiones manda SOLO en los modos de PnL.
// Después de un upsert exitoso borra las filas de ese (perfil, período) que
// quedaron en buckets AJENOS — las que hacían que el tab del mes mostrara
// $319,77 y el Historial $740,61 para el mismo agosto de Hector Gamboa. Sin
// esto, arreglar las escrituras deja el desastre quieto pero cualquier pantalla
// vieja (o un deploy a medio actualizar) lo vuelve a generar.
//
// POR QUÉ ES SERVER-SIDE Y NO UN DELETE DESDE EL CLIENTE: «la plata no puede
// depender de la corrección del navegador» (migración 079, §2.4). El cliente
// pide "limpiá el bucket de este perfil PnL", no "borrá estas filas": el route
// resuelve QUÉ se borra y verifica antes que (a) el perfil sea de PnL
// (`pnl_pct` not null) y (b) la fila que se acaba de escribir sea la del bucket
// propio. Con esas dos puertas, el peor caso de un cliente malicioso es borrar
// los duplicados que sobran de un perfil de PnL de SU propia empresa.
// Lo borrado se CUENTA y vuelve en la respuesta (§1.2: una exclusión silenciosa
// es indistinguible de un cruce roto).

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['commissions'] });
    if (auth instanceof NextResponse) return auth;

    const { period_id, head_id, entries, pnl_bucket_cleanup } = await request.json();
    if (!period_id || !head_id || !entries?.length) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // Always use the caller's verified company — never trust body.company_id
    const company_id = auth.companyId;
    const admin = createAdminClient();

    // ── Tenant-ownership validation (auditoría 2026-07-15) ──
    // period_id / head_id / profile_id vienen del body. Sin esta
    // validación, un admin de la empresa A podía enviar IDs de la
    // empresa B y (a) actualizar rows de B vía el UPDATE por id, o
    // (b) insertar rows contaminados (period de B bajo company A).
    // Mismo patrón de fetch+check que commercial-profiles ya usa.
    const { data: periodRow } = await admin
      .from('periods')
      .select('id, company_id')
      .eq('id', period_id)
      .maybeSingle();
    if (!periodRow || periodRow.company_id !== company_id) {
      return NextResponse.json(
        { error: 'El período no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    const referencedProfileIds = Array.from(
      new Set(
        entries.flatMap((e: { profile_id?: string; head_id?: string }) => [
          e.profile_id,
          e.head_id || head_id,
        ]).filter(Boolean),
      ),
    );
    // `pnl_pct`, `head_id` e `is_master_ib` viajan en el MISMO select que ya se
    // hacía para validar la propiedad: el cleanup los necesita y una segunda
    // consulta sería otra fuente que se puede desincronizar.
    const { data: ownedProfiles } = await admin
      .from('commercial_profiles')
      .select('id, pnl_pct, head_id, is_master_ib')
      .eq('company_id', company_id)
      .in('id', referencedProfileIds);
    const ownedIds = new Set((ownedProfiles ?? []).map((p) => p.id));
    const perfilPorId = new Map((ownedProfiles ?? []).map((p) => [p.id, p]));
    const foreign = referencedProfileIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      return NextResponse.json(
        { error: 'Uno o más perfiles no pertenecen a tu empresa' },
        { status: 403 },
      );
    }

    // Contadores del cleanup (ver la cabecera). Se devuelven SIEMPRE, aunque
    // sean 0: «un recorte silencioso es indistinguible de no hay más» (§1.2).
    let cleanupDeleted = 0;
    let cleanupSkipped = 0;

    for (const entry of entries) {
      const entryHeadId = entry.head_id || head_id;
      const row = {
        company_id,
        period_id,
        head_id: entryHeadId,
        profile_id: entry.profile_id,
        net_deposit_current: entry.net_deposit_current,
        net_deposit_accumulated: entry.net_deposit_accumulated,
        net_deposit_total: entry.net_deposit_current,
        division: entry.division ?? 0,
        base_amount: entry.base_amount ?? 0,
        commissions_earned: entry.commissions_earned ?? 0,
        real_payment: entry.real_payment ?? 0,
        accumulated_out: entry.accumulated_out ?? 0,
        salary_paid: entry.salary_paid ?? 0,
        total_earned: entry.total_earned ?? 0,
        pnl_current: entry.pnl_current ?? 0,
        pnl_accumulated: 0,
        pnl_total: 0,
        bonus: entry.bonus ?? 0,
        // % manual del mes (migración 129). Va SIN `?? 0` y sin preservar lo
        // que hubiera: `null` es "volvé al automático" y es justo lo que se
        // guarda cuando alguien vacía el input. Un `?? 0` acá dejaría a esa
        // persona cobrando 0% para siempre sin que nadie lo haya tecleado
        // (§1.3: null ≠ 0), y preservarlo haría imposible sacar un override.
        pct_override: entry.pct_override ?? null,
      };

      // Upsert: check if exists, then update or insert.
      // SEC: scope por company_id. Sin este filtro, un admin de la empresa A
      // que envíe profile_id/period_id/head_id de la empresa B resolvía la
      // fila de B (el UNIQUE es global y el admin client bypassa RLS) y el
      // UPDATE de abajo la sobrescribía/reasignaba a A (IDOR cross-tenant).
      const { data: existing } = await admin
        .from('commercial_monthly_results')
        .select('id')
        .eq('company_id', company_id)
        .eq('profile_id', entry.profile_id)
        .eq('period_id', period_id)
        .eq('head_id', entryHeadId)
        .maybeSingle();

      if (existing) {
        // If any field is null, preserve existing value from DB
        const hasFlags = [row.net_deposit_current, row.accumulated_out, row.net_deposit_accumulated, row.division, row.base_amount].some(v => v === null);
        if (hasFlags) {
          const { data: current } = await admin
            .from('commercial_monthly_results')
            .select('net_deposit_current, net_deposit_accumulated, accumulated_out, division, base_amount')
            .eq('id', existing.id)
            .single();
          if (row.net_deposit_current === null) row.net_deposit_current = current?.net_deposit_current ?? 0;
          if (row.net_deposit_total === null) row.net_deposit_total = row.net_deposit_current;
          if (row.net_deposit_accumulated === null) row.net_deposit_accumulated = current?.net_deposit_accumulated ?? 0;
          if (row.division === null) row.division = current?.division ?? 0;
          if (row.base_amount === null) row.base_amount = current?.base_amount ?? 0;
          if (row.accumulated_out === null) row.accumulated_out = current?.accumulated_out ?? 0;
        }
        const { error } = await admin
          .from('commercial_monthly_results')
          .update(row)
          .eq('id', existing.id)
          .eq('company_id', company_id); // defensa en profundidad: nunca tocar filas de otra empresa
        if (error) return apiError('admin/commission-entries', error, { status: 400, withSuccessFlag: false });
      } else {
        // For new inserts, replace null flags with 0
        if (row.net_deposit_current === null) row.net_deposit_current = 0;
        if (row.net_deposit_total === null) row.net_deposit_total = 0;
        if (row.net_deposit_accumulated === null) row.net_deposit_accumulated = 0;
        if (row.division === null) row.division = 0;
        if (row.base_amount === null) row.base_amount = 0;
        if (row.accumulated_out === null) row.accumulated_out = 0;
        const { error } = await admin
          .from('commercial_monthly_results')
          .insert(row);
        if (error) return apiError('admin/commission-entries', error, { status: 400, withSuccessFlag: false });
      }

      // ── Auto-limpieza del bucket PnL (ver la cabecera del archivo) ──
      // Corre DESPUÉS del upsert exitoso: si el guardado falló no se borra nada,
      // porque entonces la fila propia podría no existir todavía y el perfil
      // se quedaría sin ninguna fila del mes.
      if (pnl_bucket_cleanup === true) {
        const perfil = perfilPorId.get(entry.profile_id);
        const esDePnl = perfil != null && perfil.pnl_pct !== null && perfil.pnl_pct !== undefined;
        // LAS DOS PUERTAS. (1) el perfil tiene que ser de PnL y (2) lo que se
        // acaba de escribir tiene que ser su bucket propio — si no, el cleanup
        // borraría justamente la fila recién guardada.
        if (!esDePnl || entryHeadId !== bucketDePnl(perfil!)) {
          cleanupSkipped += 1;
        } else {
          const { data: hermanas, error: selErr } = await admin
            .from('commercial_monthly_results')
            .select('id, profile_id, head_id')
            .eq('company_id', company_id)
            .eq('period_id', period_id)
            .eq('profile_id', entry.profile_id);
          if (selErr) return apiError('admin/commission-entries', selErr, { status: 400, withSuccessFlag: false });
          // La línea ND del Master IB NO se toca: es plata del grupo de su head,
          // no un duplicado del PnL. La excepción vive en hr/pnl-buckets.ts.
          const sobrantes = (hermanas ?? []).filter(
            (r: { profile_id: string; head_id: string | null }) =>
              r.head_id !== bucketDePnl(perfil!) && !esLineaNdDeMasterIb(r, perfil!),
          );
          if (sobrantes.length > 0) {
            const ids = sobrantes.map((r: { id: string }) => r.id);
            const { error: delErr } = await admin
              .from('commercial_monthly_results')
              .delete()
              .eq('company_id', company_id) // defensa en profundidad: nunca otra empresa
              .in('id', ids);
            if (delErr) return apiError('admin/commission-entries', delErr, { status: 400, withSuccessFlag: false });
            cleanupDeleted += sobrantes.length;
            await serverAuditLog(admin, {
              companyId: company_id,
              actorId: auth.userId,
              actorName: auth.name,
              action: 'delete',
              module: 'commissions',
              details:
                `PnL bucket cleanup: ${sobrantes.length} fila(s) duplicada(s) de ${entry.profile_id} ` +
                `en el período ${period_id} (buckets ajenos: ` +
                `${sobrantes.map((r: { head_id: string | null }) => r.head_id ?? 'null').join(', ')})`,
            });
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      // Siempre presentes cuando se pidió el cleanup, para que el llamador
      // pueda mostrar/loggear lo que se borró en vez de suponerlo.
      ...(pnl_bucket_cleanup === true
        ? { pnl_bucket_cleanup: { deleted: cleanupDeleted, skipped: cleanupSkipped } }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return apiError('admin/commission-entries', err, { status: 500, withSuccessFlag: false });
  }
}
