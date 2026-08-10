// ---------------------------------------------------------------------------
// GET  /api/admin/income-lines?period_id=…  → detalle de ingresos del período
// POST /api/admin/income-lines              → reemplaza el período completo
//
// El POST manda el período ENTERO, no una línea: es el mismo contrato que
// replace_period_expenses, y la RPC borra e inserta dentro de una transacción
// que además deja operating_income.other en la suma de lo COBRADO. Guardar
// línea por línea dejaría el total desincronizado del detalle entre llamadas,
// y la cadena de socios reparte sobre ese total.
//
// company_id sale SIEMPRE del JWT. El admin client saltea RLS, así que sin
// ese filtro habría IDOR cross-tenant.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, verifyAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import {
  computeIncomeTotals,
  validateIncomeLine,
  type IncomeLine,
  type IncomeLineInput,
} from '@/lib/income-lines';

/** Tope defensivo: un período con más líneas que esto es un payload roto. */
const MAX_LINES = 300;

export async function GET(request: NextRequest) {
  try {
    // Lectura abierta a cualquier miembro de la empresa: la RLS de esta tabla
    // ya deja leer a todo el tenant y exigir FINANCE_ROLES acá solo lograba
    // que un socio con el módulo asignado viera la pantalla vacía o con
    // "sin asignar" falso. Escritura (POST/DELETE) sigue en FINANCE_ROLES.
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const periodId = request.nextUrl.searchParams.get('period_id');
    const admin = createAdminClient();

    let query = admin
      .from('income_lines')
      .select('*')
      .eq('company_id', auth.companyId)
      .order('sort_order', { ascending: true });
    if (periodId) query = query.eq('period_id', periodId);

    const { data, error } = await query;
    if (error) return apiError('admin/income-lines GET', error, { status: 500 });

    const lines = (data ?? []) as IncomeLine[];
    return NextResponse.json({
      success: true,
      lines,
      totals: computeIncomeTotals(lines),
    });
  } catch (err) {
    return apiError('admin/income-lines GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as {
      period_id?: string;
      lines?: IncomeLineInput[];
    } | null;

    const periodId = body?.period_id;
    if (!periodId) {
      return NextResponse.json({ success: false, error: 'Falta el período' }, { status: 400 });
    }
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (lines.length > MAX_LINES) {
      return NextResponse.json(
        { success: false, error: `Demasiadas líneas (máx ${MAX_LINES})` },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // El período tiene que ser de ESTA empresa: el id viene del cliente.
    const { data: period } = await admin
      .from('periods')
      .select('id, label, is_closed')
      .eq('id', periodId)
      .eq('company_id', auth.companyId)
      .maybeSingle();
    if (!period) {
      return NextResponse.json({ success: false, error: 'Período no encontrado' }, { status: 404 });
    }

    // La misma validación que la pantalla, porque la pantalla es UX y esto es
    // el control real. El índice de la fila ayuda a señalar cuál falló.
    for (let i = 0; i < lines.length; i++) {
      const error = validateIncomeLine(lines[i]);
      if (error) {
        return NextResponse.json(
          { success: false, error: `Línea ${i + 1}: ${error}` },
          { status: 400 },
        );
      }
    }

    const payload = lines.map((l, i) => ({
      concept: (l.concept ?? '').trim(),
      client: (l.client ?? '')?.toString().trim() || null,
      amount: Number(l.amount) || 0,
      received: Number(l.received) || 0,
      pending: Number(l.pending ?? 0) || 0,
      category: (l.category ?? '')?.toString().trim() || null,
      reference: (l.reference ?? '')?.toString().trim() || null,
      income_date: l.income_date || null,
      sort_order: Number.isFinite(Number(l.sort_order)) ? Number(l.sort_order) : i,
    }));

    const { data, error } = await admin.rpc('replace_income_lines', {
      p_company_id: auth.companyId,
      p_period_id: periodId,
      p_lines: payload,
    });
    if (error) {
      // El trigger de período cerrado llega como check_violation con su propio
      // mensaje, que es mostrable tal cual.
      const status = error.code === '23514' ? 409 : 500;
      return apiError('admin/income-lines POST', error, {
        status,
        clientMessage: error.message,
      });
    }

    const totals = computeIncomeTotals(payload);
    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'movements',
      details: `Ingresos de ${period.label}: ${payload.length} conceptos, cobrado ${totals.received}`,
    });

    return NextResponse.json({ success: true, received: Number(data) || 0, totals });
  } catch (err) {
    return apiError('admin/income-lines POST', err, { status: 500 });
  }
}
