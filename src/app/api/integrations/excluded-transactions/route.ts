import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// /api/integrations/excluded-transactions
//
// Marcado MANUAL de transacciones de proveedores externos (CoinsBuy, etc.)
// que NO deben contar en los totales de movimientos. Caso típico: un admin
// transfiere USDT directo a la wallet para fondear retiros — la API las
// reporta como deposits comunes pero no son cobros de cliente.
//
// Solo admin y socios marcan/desmarcan. Filtros automáticos se descartaron
// porque la API de CoinsBuy es eventually-consistent (un transfer puede
// existir antes que su deposit row, generando falsos positivos).
// ---------------------------------------------------------------------------

const ALLOWED_ROLES = ['admin', 'socio'];

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('excluded_transactions')
      .select('id, provider, external_id, reason, excluded_by_name, excluded_at')
      .eq('company_id', auth.companyId)
      .order('excluded_at', { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, excluded: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    // Los superadmins (platform_users) en modo "viewing as" llegan acá con
    // `role='admin'` por convención de verifyAdminAuth, pero igual chequeamos
    // `isSuperadmin` por defensa en profundidad — si en el futuro cambia el
    // mapeo, este endpoint sigue accesible para ellos.
    if (!ALLOWED_ROLES.includes(auth.role ?? '') && auth.isSuperadmin !== true) {
      return NextResponse.json(
        { success: false, error: 'Solo admin, socios o superadmin pueden excluir transacciones' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { provider, external_id, reason } = body as {
      provider?: string;
      external_id?: string;
      reason?: string;
    };

    if (!provider || !external_id || !reason || String(reason).trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'provider, external_id y reason son requeridos' },
        { status: 400 },
      );
    }

    // Whitelist de providers — hoy solo CoinsBuy deposits está soportado.
    if (provider !== 'coinsbuy-deposits') {
      return NextResponse.json(
        { success: false, error: 'Provider no soportado para exclusión' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Resolver nombre del usuario para mostrar en la UI luego (audit trail).
    let excludedByName: string | null = null;
    const { data: cu } = await admin
      .from('company_users')
      .select('name')
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (cu?.name) excludedByName = cu.name;
    else {
      const { data: pu } = await admin
        .from('platform_users')
        .select('name')
        .eq('user_id', auth.userId)
        .maybeSingle();
      if (pu?.name) excludedByName = pu.name;
    }

    const { data: created, error } = await admin
      .from('excluded_transactions')
      .upsert(
        {
          company_id: auth.companyId,
          provider,
          external_id: String(external_id),
          reason: String(reason).trim().slice(0, 500),
          excluded_by: auth.userId,
          excluded_by_name: excludedByName,
        },
        { onConflict: 'company_id,provider,external_id' },
      )
      .select()
      .single();

    if (error || !created) {
      return NextResponse.json(
        { success: false, error: error?.message || 'No se pudo guardar' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, excluded: created });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
