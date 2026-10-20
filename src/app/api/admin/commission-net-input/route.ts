import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildRollup } from '@/lib/hr/net-deposit';
import { indexarNetDelCrm } from '@/lib/hr/net-deposit-input';
import { separarNetDelCrm } from '@/lib/hr/overview';
import { leerPerfilesComerciales } from '@/lib/hr/crm-net-server';
import {
  computedAtMasViejo,
  leerInsumosDeCache,
  parseMesInsumos,
  recomputarInsumosComisiones,
  type InsumosDelMes,
} from '@/lib/hr/insumos-comisiones';
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
//
// ── DESDE LA MIGRACIÓN 132 LEE DE LA CACHE (dueño, 2026-10-20) ─────────────
// Las dos RPC corrían acá, EN VIVO, en cada visita. Con 30 s de timeout cada
// una y tres reintentos del cliente, una visita mala eran ~95 s de «Cargando…»
// y después «sin datos» — y quien guardaba en esa ventana fijaba insumos a
// medias (septiembre se cerró así). Ahora:
//   · CACHE HIT: un select por (empresa, mes) en `hr_insumos_comisiones` + los
//     perfiles en vivo (126 filas). Lo que tarda un select.
//   · CACHE MISS (tenant nuevo, mes viejo que el cron no recorre, o el ND de
//     ese mes nunca salió bien): calcula EN VIVO como antes, ESCRIBE la cache
//     con `recomputarInsumosComisiones` y responde. Es el fallback documentado,
//     no un camino secreto: la respuesta dice `fuente: 'en_vivo'`.
//   · LA CACHE NO SE PUEDE LEER (la 132 todavía no aplicada, o la tabla
//     falla): mismo fallback; si tampoco se puede escribir, responde con lo
//     que dieron las RPC. El deploy no depende del orden con la migración.
// Quien la llena: el cron sync-crm (mes en curso + anterior) y el botón
// «Actualizar» (POST ./refresh). La respuesta lleva `computed_at`: la hora
// del dato MÁS VIEJO en pantalla (ver `computedAtMasViejo`).
//
// LA INVERSIÓN DEL SIGNO SIGUE ACÁ, y SÓLO ACÁ: la cache guarda el `pnl_crm`
// crudo, exactamente como la RPC, y esta ruta lo da vuelta al responder —
// venga de la cache o en vivo, por el mismo `armarRespuesta`.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
/**
 * Cache hit: un select. Cache miss: las dos RPC EN PARALELO (cada una con
 * `statement_timeout = 30s` propio, así que el techo es ~30 s, no la suma) +
 * la escritura de la cache + una relectura. Entra en 60.
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

/**
 * Los insumos del mes: de la cache si está, y si no, calculados en vivo (y
 * dejados en la cache para la próxima). Ver la cabecera.
 */
async function obtenerInsumos(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  month: string,
): Promise<{ insumos: InsumosDelMes; fuente: 'cache' | 'en_vivo' }> {
  const cache = await leerInsumosDeCache(admin, companyId, month);
  if (cache.estado === 'ok') return { insumos: cache.insumos, fuente: 'cache' };

  if (cache.estado === 'error') {
    console.warn(`[commission-net-input] cache ilegible para ${month}; se calcula en vivo`);
  }

  const r = await recomputarInsumosComisiones(admin, companyId, month);
  if (r.escrito) {
    // Se relee en vez de usar `r.crudos`: si sólo una métrica salió bien, la
    // cache puede tener la otra de un cálculo anterior (merge por columna), y
    // la respuesta tiene que ser lo que quedó guardado, no lo que dio esta
    // corrida.
    const re = await leerInsumosDeCache(admin, companyId, month);
    if (re.estado === 'ok') return { insumos: re.insumos, fuente: 'en_vivo' };
  }

  // La cache no se pudo escribir o releer: se responde con lo que dieron las
  // RPC, exactamente como antes de la 132.
  const ahora = new Date().toISOString();
  return {
    insumos: {
      netRows: r.crudos.netRows,
      pnlRows: r.crudos.pnlRows,
      ndComputedAt: r.crudos.netRows ? ahora : null,
      pnlComputedAt: r.crudos.pnlRows ? ahora : null,
    },
    fuente: 'en_vivo',
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['commissions'] });
    if (auth instanceof NextResponse) return auth;

    const month = parseMesInsumos(new URL(request.url).searchParams.get('month'));
    if (!month) {
      return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
    }

    const admin = createAdminClient();
    const companyId = auth.companyId;

    // Los perfiles y los insumos en paralelo: son independientes. Los perfiles
    // van SIEMPRE en vivo (la estructura es la que la pantalla usa en todo lo
    // demás; ver la cabecera de la migración 132).
    const [profiles, { insumos, fuente }] = await Promise.all([
      leerPerfilesComerciales(admin, companyId),
      obtenerInsumos(admin, companyId, month),
    ]);
    const { netRows, pnlRows } = insumos;

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
      // La hora del dato MÁS VIEJO en pantalla (el ND y el PnL pueden tener
      // edades distintas por el merge por columna). La pantalla la muestra
      // como «CRM calculado hace X min».
      computed_at: computedAtMasViejo(insumos.ndComputedAt, pnlRows ? insumos.pnlComputedAt : null),
      nd_computed_at: insumos.ndComputedAt,
      pnl_computed_at: pnlRows ? insumos.pnlComputedAt : null,
      // 'cache' = lo dejó el cron o «Actualizar»; 'en_vivo' = cache miss, se
      // calculó en esta request (y quedó guardado).
      fuente,
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
