import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildRollup, monthToFirstDay } from '@/lib/hr/net-deposit';
import { indexarNetDelCrm } from '@/lib/hr/net-deposit-input';
import { separarNetDelCrm } from '@/lib/hr/overview';
import { leerNetDelCrm, leerPerfilesComerciales, leerPnlInputDelCrm } from '@/lib/hr/crm-net-server';
import { round2 } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/commission-net-input?month=YYYY-MM
//
// El INSUMO automático del motor de comisiones: `own` y `total` por perfil
// (net deposit), y desde la migración 123 también los dos campos del grupo PnL.
// Nada más — no calcula comisiones, no lee ni escribe
// `commercial_monthly_results`. La política (automático manda, manual es
// override, cerrado se congela) la aplica el resolver puro
// `resolveNetDepositInput`, que corre en el cliente con este dato y el manual
// que la pantalla ya tiene cargado.
//
// ── EL SIGNO DEL PnL SE INVIERTE ACÁ, Y SÓLO ACÁ ────────────────────────────
// La RPC `hr_pnl_input_by_profile` devuelve `pnl_crm` con el signo CRUDO del
// CRM: NEGATIVO = los clientes de esa red perdieron = el bróker ganó (mismo
// criterio que las migraciones 106, 122 y 123). El campo «PnL» de /comisiones
// significa lo contrario —lo que la EMPRESA gana, que es sobre lo que se paga
// la comisión— así que:
//
//     campo de pantalla = − pnl_crm            (decisión del dueño, 2026-09-02)
//
//   · PNL Report NEGATIVO (clientes perdieron) → campo POSITIVO → comisión.
//   · PNL Report POSITIVO (clientes ganaron)   → campo NEGATIVO → deuda.
//
// ESTE ENDPOINT ES EL ÚNICO PUNTO DE INVERSIÓN de todo el camino. La RPC
// entrega crudo y la pantalla consume listo, a propósito: un signo invertido en
// dos lugares se cancela y uno invertido en ninguno paga al revés, y las dos
// cosas dan un número plausible sin lanzar ninguna excepción (§1.2). Si algún
// día hace falta el crudo en otra pantalla, se agrega un campo nuevo — no se
// mueve la inversión de acá.
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
/**
 * La RPC del net tarda ~2 s con 21.182 clientes (migración 115: índices +
 * timeout). La del PnL corre EN PARALELO con ella y con el paginado de
 * perfiles, así que el techo sigue siendo el de la más lenta, no la suma. Las
 * dos RPC tienen `statement_timeout = 30s` propio.
 */
export const maxDuration = 60;

/**
 * Un `numeric` de PostgREST puede llegar como texto. `Number(null)` es 0, así
 * que el null se descarta ANTES de convertir: ese 0 sería exactamente el
 * "cero tranquilizador" que la migración 123 pide no mostrar.
 */
function numeroOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

    // Las tres lecturas en paralelo: son independientes entre sí y la del PnL
    // no puede empujar el tiempo de respuesta de las otras dos.
    const [profiles, netRows, pnlRows] = await Promise.all([
      leerPerfilesComerciales(admin, companyId),
      leerNetDelCrm(admin, companyId, month),
      leerPnlInputDelCrm(admin, companyId, month),
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

    // El PnL NO tumba el net deposit. Son dos insumos de dos grupos de gente
    // distintos: que la subred de 3.222 usuarios de un perfil PnL haga timeout
    // no es razón para dejar sin automático a los 120 perfiles de net deposit.
    // Y el fallo se DICE (`pnlError`) en vez de mandar un `[]`: una lista vacía
    // muda se leería como "ningún perfil PnL produjo este mes" y la pantalla
    // llenaría los campos con ceros (§1.2).
    //
    // El mensaje es fijo y no lleva el error de Postgres: `apiError` y la §5
    // prohíben devolver `error.message` al cliente. El detalle queda en el log
    // del servidor, que es donde lo puso `leerPnlInputDelCrm`.
    const pnlError = pnlRows ? null : 'No se pudo leer el insumo PnL del CRM para ese mes';

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
      // Los dos insumos del grupo PnL, ya con el signo dado vuelta (ver la
      // cabecera). `null` = la RPC falló y hay que decirlo; `[]` sería una
      // afirmación distinta ("no hay perfiles PnL") y por eso no se usa para
      // reportar el fallo.
      pnlEntries: pnlRows
        ? pnlRows.map((r) => {
            const pnlCrudo = numeroOrNull(r.pnl_crm);
            const comLotes = numeroOrNull(r.com_lotes);
            return {
              profileId: r.profile_id,
              // LA INVERSIÓN. `-0` no existe acá porque round2 lo normaliza.
              pnl: pnlCrudo === null ? null : round2(-pnlCrudo),
              comLotes: comLotes === null ? null : round2(comLotes),
              usuariosRed: numeroOrNull(r.usuarios_red),
              // Perfil sin usuario en el CRM: la 123 devuelve las tres columnas
              // en NULL a la vez. La pantalla tiene que decir «sin dato CRM» y
              // dejar el campo como estaba, nunca escribirle un 0.
              sinDatoCrm: pnlCrudo === null && comLotes === null,
            };
          })
        : null,
      pnlError,
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
