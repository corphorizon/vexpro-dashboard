import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildRollup, monthToFirstDay } from '@/lib/hr/net-deposit';
import { indexarNetDelCrm } from '@/lib/hr/net-deposit-input';
import { separarNetDelCrm } from '@/lib/hr/overview';
import { leerNetDelCrm, leerPerfilesComerciales } from '@/lib/hr/crm-net-server';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/commission-net-input?month=YYYY-MM
//
// El INSUMO automático del motor de comisiones: `own` y `total` por perfil,
// sacados del CRM. Nada más — no calcula comisiones, no lee ni escribe
// `commercial_monthly_results`. La política (automático manda, manual es
// override, cerrado se congela) la aplica el resolver puro
// `resolveNetDepositInput`, que corre en el cliente con este dato y el manual
// que la pantalla ya tiene cargado.
//
// ── Por qué no reusa /api/admin/hr-overview ────────────────────────────────
// Aquél está gateado por el módulo `hr` (leer lo decide el módulo, §4.1) y
// devuelve además metas, warnings y el histórico de llamados de atención. Un
// usuario de Comisiones no tiene por qué poder leer eso, ni Comisiones tiene
// por qué pagar esas cuatro consultas. Mismo gate que
// /api/admin/commission-entries: rol de dominio HR, módulo `commissions`.
//
// El trabajo pesado (la RPC del rollup) y el paginado de perfiles salen del
// registro único src/lib/hr/crm-net-server.ts; el árbol, de buildRollup. No hay
// una segunda implementación de nada de eso acá.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
/** La RPC tarda ~2 s con 21.182 clientes (migración 115: índices + timeout). */
export const maxDuration = 60;

/** `2026-07` o `2026-07-01`; cualquier otra cosa se rechaza. */
function parseMonth(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return monthToFirstDay(raw);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['commissions'] });
    if (auth instanceof NextResponse) return auth;

    const month = parseMonth(new URL(request.url).searchParams.get('month'));
    if (!month) {
      return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
    }

    const admin = createAdminClient();
    const companyId = auth.companyId;

    const [profiles, netRows] = await Promise.all([
      leerPerfilesComerciales(admin, companyId),
      leerNetDelCrm(admin, companyId, month),
    ]);

    // Sin cualquiera de los dos NO se devuelve un árbol en cero: el cliente
    // trataría eso como "este mes no produjo nadie" y le metería $0 al motor.
    // Un 502 hace que el resolver quede con `crm: null` = SIN DATOS, y la
    // pantalla lo dice.
    if (!profiles || !netRows) {
      return NextResponse.json(
        { error: 'No se pudo calcular el net del CRM para ese mes' },
        { status: 502 },
      );
    }

    const { netByProfile, unassigned } = separarNetDelCrm(netRows);
    const tree = buildRollup(profiles, netByProfile);
    const totalAssigned = [...netByProfile.values()].reduce((s, v) => s + v, 0);

    return NextResponse.json({
      month,
      // Plano y no el árbol: el cliente lo consume como índice por perfil. El
      // árbol completo lo sigue devolviendo /api/admin/hr-net-deposit-rollup,
      // que es el que dibuja la estructura.
      entries: [...indexarNetDelCrm(tree)].map(([profileId, v]) => ({
        profileId,
        own: v.own,
        total: v.total,
      })),
      // Los huérfanos se MUESTRAN, no se reparten: repartirlos entre los heads
      // sería inventar producción (§ migración 097).
      unassigned,
      totalAssigned,
      totalCrm: totalAssigned + unassigned,
    });
  } catch (err) {
    return apiError('admin/commission-net-input', err, { status: 500, withSuccessFlag: false });
  }
}
