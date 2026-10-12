'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Frescura del dato — «Actualizado hace X min» en la topbar.
//
// POR QUÉ (2026-10-12, Fase 4 «Libro mayor», docs/diseno-libro-mayor.md §6.2):
// cada número tiene que decir de cuándo es. Pero la shell NO conoce ninguna
// sincronización: `/api/bootstrap` no devuelve `synced_at` y el data-context
// no guarda cuándo llegó cada slice. Las marcas reales viven en las pantallas
// que ya las leen —`fetchedAt` de /api/integrations/persisted-movements (que es
// el `last_synced_at` de `api_sync_log`, o `null` si nunca sincronizó) y
// `lastSyncedAt` del espejo del hedge fund—.
//
// Así que la pantalla REPORTA lo que sabe con `useReportDataFreshness` y la
// topbar lo muestra. Si ninguna pantalla reportó, la topbar no muestra nada:
// un «Actualizado hace 0 min» armado con `new Date()` sería un reloj inventado
// que se lee como «el dato está al día» (reglas-del-proyecto §1.3: «no lo
// sabemos» no es lo mismo que «cero»).
//
// Con varias fuentes en la misma pantalla se muestra la MÁS VIEJA: la frase
// habla del dato de la pantalla, y si una parte tiene 26 h, decir «hace 3 min»
// por la otra parte escondería justo lo que importa.
//
// Descartado:
//   · Consultar `api_sync_log` desde la topbar: un request más por pantalla,
//     y en las que no muestran movimientos de API sería una frescura que no
//     habla del dato que se ve.
//   · Tomar la hora de carga del bootstrap: es cuándo LEÍMOS la base, no
//     cuándo se sincronizó el dato — confundirlas es exactamente el error.
// ─────────────────────────────────────────────────────────────────────────────

/** A partir de acá el punto pasa de `pos` a `stale`. Mismo umbral que el
 *  espejo del hedge fund (`HF_MIRROR_STALE_MS`, 24 h). */
export const FRESHNESS_STALE_MS = 24 * 60 * 60 * 1000;

/** «hace 3 min» — puro (testeado en data-freshness.test.ts). */
export function relativeAgo(
  iso: string,
  now: number,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const diffMin = Math.floor((now - Date.parse(iso)) / 60_000);
  // Reloj del cliente atrasado respecto del servidor: no mostrar «hace -2 min».
  if (diffMin < 1) return t('shell.justNow');
  if (diffMin < 60) return t('shell.minutesAgo', { n: String(diffMin) });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 48) return t('shell.hoursAgo', { n: String(diffH) });
  return t('shell.daysAgo', { n: String(Math.floor(diffH / 24)) });
}

interface FreshnessState {
  /** La marca más vieja reportada por la pantalla, o `null` si nadie reportó. */
  oldest: string | null;
  report: (source: string, iso: string | null) => void;
}

const FreshnessContext = createContext<FreshnessState | null>(null);

export function isRealSyncTimestamp(iso: string | null | undefined): iso is string {
  if (!iso) return false;
  const t = Date.parse(iso);
  // `new Date(0)` es el «nunca» que algunos endpoints mandan como relleno.
  return Number.isFinite(t) && t > 0;
}

export function DataFreshnessProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Record<string, string>>({});

  const report = useCallback((source: string, iso: string | null) => {
    setSources((prev) => {
      if (!isRealSyncTimestamp(iso)) {
        if (!(source in prev)) return prev;
        const next = { ...prev };
        delete next[source];
        return next;
      }
      if (prev[source] === iso) return prev;
      return { ...prev, [source]: iso };
    });
  }, []);

  const oldest = useMemo(() => {
    let best: string | null = null;
    for (const iso of Object.values(sources)) {
      if (best === null || Date.parse(iso) < Date.parse(best)) best = iso;
    }
    return best;
  }, [sources]);

  const value = useMemo(() => ({ oldest, report }), [oldest, report]);
  return <FreshnessContext.Provider value={value}>{children}</FreshnessContext.Provider>;
}

/**
 * Una pantalla declara de cuándo es su dato. `iso = null` (todavía no llegó,
 * o la fuente nunca sincronizó) retira la marca. Al desmontar la pantalla la
 * marca se retira sola: la frescura de Movimientos no queda pegada en Egresos.
 *
 * Fuera del provider no hace nada (pantallas fuera del dashboard).
 */
export function useReportDataFreshness(source: string, iso: string | null | undefined): void {
  const ctx = useContext(FreshnessContext);
  const report = ctx?.report;
  useEffect(() => {
    if (!report) return;
    report(source, iso ?? null);
    return () => report(source, null);
  }, [report, source, iso]);
}

/** La marca que muestra la topbar. */
export function useDataFreshness(): string | null {
  return useContext(FreshnessContext)?.oldest ?? null;
}
