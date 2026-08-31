import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildPeriodCloseChecklist } from '@/lib/period-close-checklist-data';

// ---------------------------------------------------------------------------
// POST /api/admin/data — dispatcher server-side de escrituras de datos.
//
// Por qué (2026-07-13): escribir desde el browser con el cliente supabase-js se
// cuelga de forma recurrente — supabase-js intenta refrescar el token de auth
// antes de cada request y ese refresh se estanca (navigator.locks/red), aunque
// la DB responde en ms. Moviendo TODAS las escrituras acá, el browser hace un
// fetch simple con su cookie de sesión (sin refresh-token dance) y el server
// corre la operación con el admin client. Elimina la clase entera de cuelgues.
//
// Seguridad: verifyAdminAuth resuelve company_id desde el JWT (nunca del body).
// El admin client bypassa RLS, así que TODA operación por id filtra además por
// company_id para prevenir IDOR cross-tenant. Los inserts fuerzan company_id
// del token. Las RPC replace_period_* tienen bypass de service_role.
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// SANITIZADO DE PAYLOADS (auditoría 2026-08-06, hallazgo crítico).
//
// Antes: `.insert({ ...stripProtected(body.movement), company_id: companyId })` — el spread va
// DESPUÉS, así que un body con company_id de otra empresa GANABA y escribía
// cross-tenant con el cliente service-role (sin RLS que lo atrape). El
// comentario del archivo afirmaba lo contrario. Y `.update(body.updates)`
// aceptaba pisar id/company_id/created_at.
//
// Ahora: el spread va PRIMERO y company_id del token lo pisa; los updates
// pasan por stripProtected. Defensa central, no por operación.
// ─────────────────────────────────────────────────────────────────────────────
const PROTECTED_KEYS = ['id', 'company_id', 'created_at', 'updated_at'];

function stripProtected(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const k of PROTECTED_KEYS) delete out[k];
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['upload', 'expenses', 'income', 'liquidity', 'investments', 'balances', 'partners', 'periods', 'movements'] });
    if (auth instanceof NextResponse) return auth;
    const companyId = auth.companyId;
    const admin = createAdminClient();

    const body = await request.json();
    const op = body?.op as string;

    // Helper: devuelve error 500 con el detalle logueado si `error` existe.
    const fail = (error: unknown, ctx: string) => apiError(`admin/data:${ctx}`, error, { status: 500 });

    switch (op) {
      // ── Period-scoped replaces (RPC atómica) ──
      case 'deposits': {
        const { error } = await admin.rpc('replace_period_deposits', {
          p_company_id: companyId, p_period_id: body.periodId, p_rows: body.rows ?? [],
        });
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'withdrawals': {
        const { error } = await admin.rpc('replace_period_withdrawals', {
          p_company_id: companyId, p_period_id: body.periodId, p_rows: body.rows ?? [],
        });
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Single-row-per-period upserts ──
      case 'operating_income': {
        const { error } = await admin.from('operating_income').upsert(
          { company_id: companyId, period_id: body.periodId, prop_firm: body.income.prop_firm, broker_pnl: body.income.broker_pnl, other: body.income.other },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'prop_firm_sales': {
        const { error } = await admin.from('prop_firm_sales').upsert(
          { company_id: companyId, period_id: body.periodId, amount: body.amount },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'p2p_transfers': {
        const { error } = await admin.from('p2p_transfers').upsert(
          { company_id: companyId, period_id: body.periodId, amount: body.amount },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'channel_balance': {
        const { error } = await admin.from('channel_balances').upsert(
          { company_id: companyId, snapshot_date: body.snapshotDate, channel_key: body.channelKey, amount: body.amount, source: body.source ?? 'manual' },
          { onConflict: 'company_id,snapshot_date,channel_key' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Liquidity movements ──
      case 'liquidity_insert': {
        const { data, error } = await admin.from('liquidity_movements')
          .insert({ ...stripProtected(body.movement), company_id: companyId }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'liquidity_update': {
        const { data, error } = await admin.from('liquidity_movements')
          .update(stripProtected(body.updates)).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'liquidity_delete': {
        const { error } = await admin.from('liquidity_movements').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Investments ──
      case 'investment_insert': {
        const { data, error } = await admin.from('investments')
          .insert({ ...stripProtected(body.investment), company_id: companyId }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'investment_update': {
        const { data, error } = await admin.from('investments')
          .update(stripProtected(body.updates)).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'investment_delete': {
        const { error } = await admin.from('investments').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Partners ──
      case 'partner_create': {
        const { data, error } = await admin.from('partners')
          .insert({ company_id: companyId, name: body.name, email: body.email, percentage: body.percentage }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'partner_update': {
        const { data, error } = await admin.from('partners')
          .update(stripProtected(body.updates)).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'partner_delete': {
        // Borrar distribuciones del socio primero (scoped a la empresa).
        const { error: distErr } = await admin.from('partner_distributions').delete().eq('partner_id', body.id).eq('company_id', companyId);
        if (distErr) return fail(distErr, op);
        const { error } = await admin.from('partners').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Periods ──
      case 'period_status': {
        // Migración 061: cerrar y reabrir NO son un update de un booleano.
        // Cerrar congela los totales en closing_snapshot y activa el bloqueo
        // de escrituras; reabrir exige un motivo y queda auditado. Un update
        // crudo de `is_closed` se saltearía las dos cosas.
        if (body.isClosed) {
          // El checklist se calcula ANTES de cerrar: después el estado ya
          // cambió y «qué había pendiente cuando cerramos» sería otra cosa.
          // Se computa server-side y NO se acepta del cliente: un checklist
          // que manda el navegador no es evidencia de nada.
          let checklist: Awaited<ReturnType<typeof buildPeriodCloseChecklist>> = null;
          try {
            checklist = await buildPeriodCloseChecklist(admin, companyId, body.periodId);
          } catch (checklistErr) {
            // No fatal: el cierre es la operación importante. Queda el aviso
            // en el log y la fila de checklist no se escribe — que es
            // honesto: no se guarda una foto que no se pudo sacar.
            console.error('[admin/data:period_status] checklist previo:', checklistErr);
          }

          const { error } = await admin.rpc('close_period', {
            p_company_id: companyId,
            p_period_id: body.periodId,
            p_actor_id: auth.userId,
            p_actor_name: auth.name || auth.email,
          });
          if (error) return fail(error, op);

          if (checklist) {
            // Después del cierre, para que no quede una foto de un cierre que
            // la RPC terminó rechazando (p. ej. por orden cronológico).
            const { error: snapErr } = await admin.from('period_close_checklists').insert({
              company_id: companyId,
              period_id: body.periodId,
              closed_by: auth.userId,
              closed_by_name: auth.name || auth.email,
              items: checklist.items,
              clean: checklist.clean,
            });
            if (snapErr) {
              console.error('[admin/data:period_status] guardando checklist:', snapErr.message);
            }
          }
          return NextResponse.json({ success: true });
        }

        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (!reason) {
          return NextResponse.json(
            { error: 'Reabrir un período cerrado requiere un motivo' },
            { status: 400 },
          );
        }
        const { error } = await admin.rpc('reopen_period', {
          p_company_id: companyId,
          p_period_id: body.periodId,
          p_actor_id: auth.userId,
          p_actor_name: auth.name || auth.email,
          p_reason: reason,
        });
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'period_reserve': {
        // La reserva es un multiplicador de la fórmula de distribución: un
        // valor fuera de 0..1 produce montos negativos o infla la reserva Nx.
        // La única validación vivía en el cliente (auditoría, hallazgo C4).
        const pct = Number(body.reservePct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
          return NextResponse.json(
            { error: 'reserve_pct debe estar entre 0 y 1' },
            { status: 400 },
          );
        }
        const { error } = await admin.from('periods').update({ reserve_pct: pct }).eq('id', body.periodId).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'period_reserve_all': {
        const pct = Number(body.reservePct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
          return NextResponse.json(
            { error: 'reserve_pct debe estar entre 0 y 1' },
            { status: 400 },
          );
        }
        // Solo períodos ABIERTOS: sin este filtro, "aplicar a todos"
        // reescribía la reserva de meses cerrados y recalculaba
        // retroactivamente lo que ya se distribuyó a los socios — la
        // operación con mayor blast radius del producto (hallazgo C4).
        const { error } = await admin
          .from('periods')
          .update({ reserve_pct: pct })
          .eq('company_id', companyId)
          .eq('is_closed', false);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Pinned Coinsbuy wallets ──
      // El ROL decide qué significa el pin (migración 084):
      //   · 'operating' → cuenta como depósitos/retiros de clientes Y suma al
      //                   balance consolidado
      //   · 'internal'  → SOLO suma al balance (ahorro, pago de egresos)
      // Se valida acá y no solo en la UI: un rol inventado que pasara el
      // CHECK de la DB por accidente movería plata en la cadena de
      // distribución (fue el bug de agosto 2026 en Vex Pro: dos wallets
      // internas metieron $462.793,85 de retiros falsos).
      case 'pin_wallet': {
        const role = body.role === 'internal' ? 'internal' : 'operating';
        const { error } = await admin.from('pinned_coinsbuy_wallets')
          .insert({ company_id: companyId, wallet_id: body.walletId, wallet_label: body.walletLabel, role });
        if (error && error.code !== '23505') return fail(error, op); // 23505 = ya fijada
        return NextResponse.json({ success: true });
      }
      case 'pin_wallet_role': {
        if (body.role !== 'operating' && body.role !== 'internal') {
          return NextResponse.json(
            { error: "role debe ser 'operating' o 'internal'" },
            { status: 400 },
          );
        }
        const { error } = await admin.from('pinned_coinsbuy_wallets')
          .update({ role: body.role })
          .eq('company_id', companyId)
          .eq('wallet_id', body.walletId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'unpin_wallet': {
        const { error } = await admin.from('pinned_coinsbuy_wallets').delete().eq('company_id', companyId).eq('wallet_id', body.walletId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Expense ordering + templates ──
      case 'expense_order': {
        const ids: string[] = body.ids ?? [];
        const results = await Promise.all(
          ids.map((id, i) => admin.from('expenses')
            .update({ sort_order: i + 1, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', companyId)),
        );
        const firstErr = results.find((r) => r.error)?.error;
        if (firstErr) return fail(firstErr, op);
        return NextResponse.json({ success: true });
      }
      case 'expense_template_set_active': {
        const { error } = await admin.from('expense_templates').update({ active: !!body.active }).eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'expense_template_delete': {
        const { error } = await admin.from('expense_templates').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      // Ocultar una plantilla fija en UN período (migration-050).
      //   1. registra el override (idempotente sobre el UNIQUE);
      //   2. borra la fila de egreso YA materializada de ese concepto en ese
      //      período, para que desaparezca también en meses ya guardados.
      case 'expense_template_hide': {
        const { data: tpl } = await admin
          .from('expense_templates')
          .select('concept')
          .eq('id', body.templateId)
          .eq('company_id', companyId)
          .maybeSingle();
        if (!tpl) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 });

        const { error: hideErr } = await admin
          .from('expense_template_period_hidden')
          .upsert(
            { company_id: companyId, template_id: body.templateId, period_id: body.periodId },
            { onConflict: 'template_id,period_id', ignoreDuplicates: true },
          );
        if (hideErr) return fail(hideErr, op);

        // Quitar la fila materializada de ese concepto (solo fijos).
        const { error: delErr } = await admin
          .from('expenses')
          .delete()
          .eq('company_id', companyId)
          .eq('period_id', body.periodId)
          .eq('concept', tpl.concept)
          .eq('is_fixed', true);
        if (delErr) return fail(delErr, op);
        return NextResponse.json({ success: true });
      }
      // Mostrar de nuevo una plantilla oculta en un período.
      //   1. elimina el override;
      //   2. si el período ya tiene egresos (está guardado) y el concepto no
      //      está presente, re-inserta la fila fija con la categoría heredada
      //      del expense más reciente con el mismo concepto. Para períodos no
      //      guardados no hace falta: el preview de /upload lo vuelve a mostrar.
      case 'expense_template_unhide': {
        const { error: unhideErr } = await admin
          .from('expense_template_period_hidden')
          .delete()
          .eq('company_id', companyId)
          .eq('template_id', body.templateId)
          .eq('period_id', body.periodId);
        if (unhideErr) return fail(unhideErr, op);

        const { data: tpl } = await admin
          .from('expense_templates')
          .select('concept, amount')
          .eq('id', body.templateId)
          .eq('company_id', companyId)
          .maybeSingle();
        if (!tpl) return NextResponse.json({ success: true }); // plantilla borrada; nada que re-insertar

        const { data: periodRows } = await admin
          .from('expenses')
          .select('id, concept')
          .eq('company_id', companyId)
          .eq('period_id', body.periodId);
        const periodIsSaved = (periodRows ?? []).length > 0;
        const alreadyPresent = (periodRows ?? []).some((r) => r.concept === tpl.concept);

        if (periodIsSaved && !alreadyPresent) {
          // Heredar categoría del expense más reciente con el mismo concepto.
          const { data: latest } = await admin
            .from('expenses')
            .select('category, period_id')
            .eq('company_id', companyId)
            .eq('concept', tpl.concept)
            .not('category', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          const { error: insErr } = await admin.from('expenses').insert({
            company_id: companyId,
            period_id: body.periodId,
            concept: tpl.concept,
            amount: tpl.amount,
            paid: 0,
            pending: tpl.amount,
            is_fixed: true,
            category: latest?.category ?? null,
          });
          if (insErr) return fail(insErr, op);
        }
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Operación desconocida: ${op}` }, { status: 400 });
    }
  } catch (err) {
    return apiError('admin/data', err, { status: 500 });
  }
}
