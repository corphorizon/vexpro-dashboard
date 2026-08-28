// ─────────────────────────────────────────────────────────────────────────────
// Detección de copia entre las cuentas ya diagnosticadas.
//
// ── POR QUÉ ES UNA FASE APARTE Y NO VA DENTRO DE LA ROTACIÓN ───────────────
// Porque la sincronía es una RELACIÓN entre dos cuentas, no una propiedad de
// una. La rotación procesa 200 por corrida; si la copia se calculara ahí, sólo
// se verían los pares que caen en la misma tanda — y dos cuentas que se copian
// entre tandas distintas nunca se cruzarían. Peor: el resultado dependería del
// orden de la rotación, así que la misma pareja aparecería o no según el día.
//
// Así que esto corre sobre TODAS las cuentas candidatas a la vez, después de la
// rotación, y actualiza sólo la señal de copia.
//
// ── QUÉ MOTIVÓ ESTO (medido, 2026-08-27) ───────────────────────────────────
// Las primeras 13 cuentas que salieron en riesgo alto eran casi idénticas:
// 25.000 operaciones, ~55% de menos de un minuto, todas sobre XAUUSD y
// alrededor de las mismas noticias. Y pertenecían a TRECE usuarios distintos.
//
// Trece personas operando igual no es coincidencia: o se copian, o siguen la
// misma señal. La diferencia no está en los datos —lo dice la cabecera de
// copy-detection.ts— pero saber que el grupo existe ya cambia a quién mirar.
//
// ── EL UMBRAL DE ACTIVIDAD, Y POR QUÉ NO ES CERO ───────────────────────────
// La mediana de operaciones por cuenta es OCHO. Meter todas al emparejamiento
// multiplicaría el costo para comparar cuentas que no pueden dar una respuesta:
// con menos de MIN_COINCIDENCIAS (5) coincidencias no hay par posible.
//
// El umbral es 10 y no más alto a propósito: la cobertura se mide contra la
// cuenta MÁS CHICA, así que una cuenta de 20 operaciones enteramente replicada
// dentro de una de 400 ES un hallazgo — subir el umbral lo escondería.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadAperturasByLogins,
  findSynchronizedPairs,
  MIN_COBERTURA,
} from '@/lib/risk/copy-detection';
import {
  SENALES_DE_RIESGO,
  RIESGO_ALTO,
  RIESGO_MEDIO,
  type AccountSignal,
  type AccountRisk,
} from '@/lib/risk/account-review';

/**
 * Ventana de análisis.
 *
 * ── POR QUÉ 30 Y NO 120 COMO PROP FIRM ─────────────────────────────────────
 * Porque acá el universo es otro. Prop firm empareja 42.914 aperturas de 1.115
 * cuentas en 120 días; estas cuentas incluyen bots con 25.000 posiciones cada
 * uno. Estimado el 2026-08-27 sobre las 237 candidatas ya diagnosticadas:
 *
 *     120 días → ~1.083.000 aperturas
 *      60 días →   ~669.000
 *      45 días →   ~460.000
 *      30 días →   ~250.000
 *
 * Con 120 días la primera corrida topó el techo y se saltó el veredicto —
 * correcto, pero significa que la señal nunca se resolvía. Treinta días bajan
 * el volumen a algo que una función serverless puede mover por el túnel, y
 * siguen siendo de sobra: se piden 5 coincidencias para considerar un par, y
 * quien copia opera todas las semanas. La copia es un comportamiento del
 * presente, no del historial.
 */
export const DIAS = 30;

/** Mínimo de operaciones en la ventana para entrar al emparejamiento. */
export const MIN_OPERACIONES = 10;

/**
 * Techo de aperturas a traer.
 *
 * Prop firm empareja 42.914 aperturas de 1.115 cuentas sin problema. Acá hay
 * cuentas con 25.000 posiciones cada una, así que el volumen puede ser mucho
 * mayor. Si se llega al techo se AVISA y no se escribe ningún veredicto de
 * copia: media muestra produciría pares falsos por omisión —una cuenta cuyas
 * operaciones no se trajeron parece «no copia»— y eso es peor que no responder.
 *
 * El número sale de la estimación de DIAS: 30 días sobre las 237 candidatas
 * medidas dan ~250.000, y extrapolado a las ~624 cuentas del universo completo
 * queda cerca de 390.000. Se deja 600.000 para que el techo sea una red de
 * seguridad ante un crecimiento raro y no algo que se dispare en la operación
 * normal — que es exactamente lo que pasó con el valor anterior.
 */
export const MAX_APERTURAS = 600_000;

export interface CopySyncResult {
  candidates: number;
  aperturas: number;
  pairs: number;
  updated: number;
  elapsedMs: number;
  warnings: string[];
}

export async function syncAccountCopyDetection(
  admin: SupabaseClient,
  companyId: string,
): Promise<CopySyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const vacio = (extra: Partial<CopySyncResult> = {}): CopySyncResult => ({
    candidates: 0, aperturas: 0, pairs: 0, updated: 0,
    elapsedMs: Date.now() - started, warnings, ...extra,
  });

  // ── 1. Candidatas: las que ya tienen diagnóstico y actividad suficiente ──
  const { data: filas, error } = await admin
    .from('mt5_account_review')
    .select('login, positions, first_trade_at, last_trade_at, checks, unverifiable')
    .eq('company_id', companyId)
    .gte('positions', MIN_OPERACIONES);
  if (error) throw new Error(`mt5_account_review: ${error.message}`);

  const candidatas = (filas ?? []).map((f) => Number(f.login)).filter((n) => Number.isFinite(n));
  if (candidatas.length < 2) return vacio({ candidates: candidatas.length });

  // ── 2. Elegir la ventana ANTES de consultar ─────────────────────────────
  // El volumen crece con el universo, y el universo crece solo (cada retiro
  // nuevo suma cuentas). Una ventana fija se pasa del techo tarde o temprano y
  // ahí la señal deja de resolverse — ya pasó una vez con 120 días.
  //
  // Se estima con lo que YA está guardado (posiciones y fechas de cada cuenta,
  // prorrateadas a la ventana): cuesta cero y evita descubrir el problema
  // después de haber traído un millón de filas por el túnel.
  //
  // Se toma la ventana MÁS LARGA que entre bajo el techo. Más ventana es mejor
  // detección; el techo sólo marca hasta dónde se puede.
  const DIA = 86_400_000;
  const estimar = (dias: number): number => {
    const corte = Date.now() - dias * DIA;
    let total = 0;
    for (const f of filas ?? []) {
      const p = Number(f.positions) || 0;
      const ini = f.first_trade_at ? new Date(f.first_trade_at).getTime() : 0;
      const fin = f.last_trade_at ? new Date(f.last_trade_at).getTime() : 0;
      if (!ini || !fin || fin < corte) continue; // no operó en la ventana
      const spanDias = Math.max(1, (fin - ini) / DIA);
      const solapa = Math.max(0, (fin - Math.max(ini, corte)) / DIA);
      total += p * Math.min(1, solapa / spanDias);
    }
    return Math.round(total);
  };

  const VENTANAS = [DIAS, 21, 14, 7];
  const dias = VENTANAS.find((d) => estimar(d) < MAX_APERTURAS) ?? VENTANAS[VENTANAS.length - 1];
  if (dias !== DIAS) {
    warnings.push(
      `Ventana reducida a ${dias} días (con ${DIAS} la estimación era ${estimar(DIAS).toLocaleString('es')} aperturas, sobre el techo de ${MAX_APERTURAS.toLocaleString('es')}).`,
    );
  }

  // ── 3. Aperturas de todas, de una sola vez ──────────────────────────────
  const desde = new Date(Date.now() - dias * DIA);
  const aperturas = await loadAperturasByLogins(companyId, candidatas, desde);

  if (aperturas.length >= MAX_APERTURAS) {
    // Ver MAX_APERTURAS: con la muestra cortada, «no copia» sería una
    // conclusión inventada. Se avisa y se deja la señal como estaba.
    warnings.push(
      `Se alcanzó el techo de ${MAX_APERTURAS} aperturas: NO se actualizó la señal de copia ` +
      `para no emitir veredictos sobre media muestra. Hay que acotar la ventana o el universo.`,
    );
    return vacio({ candidates: candidatas.length, aperturas: aperturas.length });
  }

  // ── 4. Emparejar ────────────────────────────────────────────────────────
  const pares = findSynchronizedPairs(aperturas);

  // Por cuenta, con quién sincroniza.
  const porLogin = new Map<number, Array<{ otroLogin: number; cobertura: number; coincidencias: number; retrasoMedianoSeg: number }>>();
  const empujar = (login: number, otro: number, p: typeof pares[number]) => {
    const arr = porLogin.get(login) ?? [];
    arr.push({
      otroLogin: otro,
      cobertura: p.cobertura,
      coincidencias: p.coincidencias,
      retrasoMedianoSeg: p.retrasoMedianoSeg,
    });
    porLogin.set(login, arr);
  };
  for (const p of pares) {
    empujar(p.loginA, p.loginB, p);
    empujar(p.loginB, p.loginA, p);
  }

  // ── 5. Actualizar la señal de copia, y sólo esa ─────────────────────────
  // Las cuentas SIN par también se actualizan: pasan de «no comprobado» a
  // «ninguna cuenta opera sincronizada con ésta», que es una respuesta y no
  // una omisión. Ésa es toda la diferencia que aporta esta fase.
  let updated = 0;
  for (const f of filas ?? []) {
    const login = Number(f.login);
    const sincronizadas = porLogin.get(login) ?? [];
    const fuertes = sincronizadas.filter((x) => x.cobertura >= MIN_COBERTURA);

    const señal: AccountSignal = {
      id: 'copy_trading',
      label: 'Opera sincronizada con otras cuentas',
      status: fuertes.length > 0 ? 'fail' : 'pass',
      detail: fuertes.length > 0
        // El retraso es lo que hay que leer: un humano no hace clic con medio
        // segundo de diferencia en dos cuentas separadas.
        ? `Sincronizada con ${fuertes.length} cuenta(s): ` + fuertes
          .sort((a, b) => b.cobertura - a.cobertura)
          .slice(0, 3)
          .map((p) => `${p.otroLogin} (${Math.round(p.cobertura * 100)}%, retraso ~${p.retrasoMedianoSeg}s)`)
          .join(' · ')
        : `Ninguna de las ${candidatas.length} cuentas analizadas opera sincronizada con ésta (últimos ${dias} días)`,
      offendingTrades: fuertes.reduce((a, p) => a + p.coincidencias, 0),
      countsForRisk: true,
    };

    const previos = (f.checks as AccountSignal[] | null) ?? [];
    const checks = [
      ...previos.filter((c) => c.id !== 'copy_trading'),
      señal,
    ];
    const flagged = checks.filter((c) => c.status === 'fail' && c.countsForRisk).length;
    const unverifiable = checks.filter((c) => c.status === 'unverifiable').length;
    const risk: AccountRisk =
      flagged >= RIESGO_ALTO ? 'alto' : flagged >= RIESGO_MEDIO ? 'medio' : 'ok';

    const { error: upErr } = await admin
      .from('mt5_account_review')
      .update({ checks, violations: flagged, unverifiable, risk })
      .eq('company_id', companyId)
      .eq('login', login);
    if (upErr) {
      warnings.push(`login ${login}: ${upErr.message}`);
      continue;
    }
    updated += 1;
  }

  // Defensa: si la señal dejara de contar para el riesgo, este módulo estaría
  // escribiendo un veredicto que nadie mira. Que falle acá y no en silencio.
  if (!SENALES_DE_RIESGO.has('copy_trading')) {
    warnings.push('copy_trading ya no cuenta para el riesgo: revisar SENALES_DE_RIESGO.');
  }

  return {
    candidates: candidatas.length,
    aperturas: aperturas.length,
    pairs: pares.length,
    updated,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
