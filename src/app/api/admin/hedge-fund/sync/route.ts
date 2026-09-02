// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/hedge-fund/sync
//
// El botón «Sincronizar ahora» de la pantalla. Dispara SÓLO el espejo del hedge
// fund de la empresa activa, no el sync entero del CRM: alguien que quiere ver
// una inversión que acaba de aprobarse en el CRM no debería tener que esperar a
// que se rebarran 39.413 depósitos.
//
// ── AUTH: ACÁ SÍ MANDA EL ROL ──────────────────────────────────────────────
// Las otras cuatro rutas del módulo son de lectura y las decide el módulo
// (§4.1). Ésta ESCRIBE en nueve tablas y puede emitir una alerta, así que
// además exige FINANCE_ROLES. `company_id` sale del token, nunca del body.
//
// ── POR QUÉ ABRE SU PROPIA CONEXIÓN A MONGO ────────────────────────────────
// `syncHedgeFund` recibe una sesión ya abierta porque dentro de `runCrmSync`
// hay una. Acá no hay ninguna, así que la ruta abre la suya con
// `withOrionMongo` y la cierra en el `finally` del cliente. Es UNA conexión por
// clic manual, no por visita de pantalla — la regla G10 («nunca consultar en
// vivo desde una pantalla») es sobre las cargas automáticas, no sobre un botón
// que una persona aprieta a sabiendas.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { withOrionMongo, OrionMongoError } from '@/lib/api-integrations/orion-mongo/client';
import { syncHedgeFund } from '@/lib/crm-sync/hedge-fund';
import { serverAuditLog } from '@/lib/server-audit';

export const dynamic = 'force-dynamic';
/** Volúmenes de tres cifras: la corrida completa está muy por debajo de esto. */
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth(request, {
    roles: FINANCE_ROLES,
    modules: ['hedge_fund'],
  });
  if (auth instanceof NextResponse) return auth;

  const ranAt = new Date().toISOString();
  const admin = createAdminClient();

  try {
    const result = await withOrionMongo(auth.companyId, (session) =>
      syncHedgeFund(session, admin, auth.companyId, ranAt),
    );

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name,
      action: 'update',
      module: 'hedge_fund',
      details:
        `Sync manual del hedge fund: ${result.funds.upserted} fondos, ` +
        `${result.investments.upserted} inversiones, ${result.commissions.upserted} comisiones. ` +
        `${result.excludedTotal} fila(s) de prueba. ` +
        `Config de comisiones: ${result.configChanged ? 'CAMBIÓ' : 'sin cambios'}.`,
    });

    return NextResponse.json({ success: true, result });
  } catch (err) {
    // Una empresa sin credencial de Orion no es un error del servidor: es una
    // empresa que no tiene el CRM conectado, y decirle «500» manda a alguien a
    // buscar un bug que no existe.
    if (err instanceof OrionMongoError && err.code === 'NOT_CONFIGURED') {
      return NextResponse.json(
        { success: false, error: 'Esta empresa no tiene el CRM (Orion) configurado.' },
        { status: 409 },
      );
    }
    return apiError('admin/hedge-fund/sync', err, { status: 500 });
  }
}
