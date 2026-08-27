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

/** Ventana de análisis. La misma que usa prop firm: acota el costo y la copia
 *  es un comportamiento del presente, no del historial completo. */
export const DIAS = 120;

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
 */
export const MAX_APERTURAS = 400_000;

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
    .select('login, positions, checks, unverifiable')
    .eq('company_id', companyId)
    .gte('positions', MIN_OPERACIONES);
  if (error) throw new Error(`mt5_account_review: ${error.message}`);

  const candidatas = (filas ?? []).map((f) => Number(f.login)).filter((n) => Number.isFinite(n));
  if (candidatas.length < 2) return vacio({ candidates: candidatas.length });

  // ── 2. Aperturas de todas, de una sola vez ──────────────────────────────
  const desde = new Date(Date.now() - DIAS * 86_400_000);
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

  // ── 3. Emparejar ────────────────────────────────────────────────────────
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

  // ── 4. Actualizar la señal de copia, y sólo esa ─────────────────────────
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
        : `Ninguna de las ${candidatas.length} cuentas analizadas opera sincronizada con ésta`,
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
