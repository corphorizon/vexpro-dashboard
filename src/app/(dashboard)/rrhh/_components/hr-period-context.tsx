'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useData } from '@/lib/data-context';
import {
  mesAnterior,
  mesDePeriodo,
  periodIdsForPreset,
  type HrPeriodPreset,
  type MesAncla,
} from '@/lib/hr/period-filter';
import type { HrOverviewResponse } from '@/lib/hr/overview';

// ─────────────────────────────────────────────────────────────────────────────
// EL RELOJ Y LOS DATOS DEL MÓDULO RRHH, en un solo lugar.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// El módulo tenía tres relojes (ver la cabecera de src/lib/hr/period-filter.ts)
// y siete cargas de datos, una por pestaña. Cambiar de pestaña volvía a pagar
// la RPC del rollup. Acá el mes se elige UNA vez, arriba de las pestañas, y el
// overview de ese mes se pide UNA vez y se comparte.
//
// ── La caché ───────────────────────────────────────────────────────────────
// Es una STORE EXTERNA (useSyncExternalStore) y no estado de React: así el
// render lee lo que ya está en memoria sin pasar por un `setState` dentro de un
// efecto, y montar una pestaña con el mes ya cargado no dispara un ciclo extra.
//
// Vive en memoria del módulo, NO en localStorage, y la clave lleva la empresa:
// una caché con clave global es cómo el usuario siguiente termina viendo los
// datos del anterior. Se vacía al cambiar de empresa (el "ver como" del
// superadmin) y al recargar la página. `refetch()` la invalida para el mes
// actual — lo usan las pestañas que escriben (warnings) después de guardar.
//
// ── null ≠ 0 ───────────────────────────────────────────────────────────────
// `overview` es `null` mientras no se sabe. Las pantallas muestran "—" con eso,
// nunca $0. Y `overview.partial` dice qué pedazo no se pudo leer.
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry = { data: HrOverviewResponse | null; error: boolean };

/** clave: `${companyId}:${YYYY-MM}`. */
const cache = new Map<string, CacheEntry>();
const enVuelo = new Map<string, Promise<void>>();

// ── La store externa: una versión que sube en cada cambio de la caché ───────
let version = 0;
const listeners = new Set<() => void>();
function notificar() {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const getVersion = () => version;
/** En el servidor la caché siempre está vacía: una versión fija evita el mismatch. */
const getVersionServidor = () => 0;

function claveDe(companyId: string, month: MesAncla) {
  return `${companyId}:${month}`;
}

function pedirOverview(companyId: string, month: MesAncla): void {
  const clave = claveDe(companyId, month);
  if (cache.has(clave) || enVuelo.has(clave)) return;

  const promesa = (async () => {
    let entrada: CacheEntry;
    try {
      const res = await apiFetch(`/api/admin/hr-overview?month=${month}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'hr-overview failed');
      entrada = { data: json as HrOverviewResponse, error: false };
    } catch {
      // El fallo SÍ se guarda: si no, el efecto volvería a pedirlo en cada
      // render y una ruta caída se convertiría en un bucle de llamadas. Se
      // limpia con `refetch()` o cambiando de mes.
      entrada = { data: null, error: true };
    }
    enVuelo.delete(clave);
    cache.set(clave, entrada);
    notificar();
  })();

  enVuelo.set(clave, promesa);
}

type HrPeriodValue = {
  /** El ancla del módulo: `YYYY-MM`. TODAS las pestañas miran este mes. */
  month: MesAncla;
  setMonth: (m: MesAncla) => void;
  preset: HrPeriodPreset;
  setPreset: (p: HrPeriodPreset) => void;
  customIds: string[];
  setCustomIds: (ids: string[]) => void;
  /** Los `period_id` que entran según el preset — los usa la pestaña Comercial. */
  periodIds: string[];
  /** El overview del mes. `null` mientras carga o si falló (ver `error`). */
  overview: HrOverviewResponse | null;
  loading: boolean;
  error: boolean;
  /** Invalida la caché de este mes y vuelve a pedirlo. */
  refetch: () => void;
};

const HrPeriodContext = createContext<HrPeriodValue | null>(null);

export function HrPeriodProvider({ children }: { children: React.ReactNode }) {
  const { company, periods } = useData();
  const companyId = company?.id ?? '';

  // Default: el mes ANTERIOR. Es el que RRHH revisa (el corriente todavía corre)
  // y era el default de Net Deposit y Warnings. La pestaña Comercial arranca en
  // preset 'total', que ignora el ancla: sus números al entrar no cambian.
  const [month, setMonth] = useState<MesAncla>(() => mesAnterior());
  const [preset, setPreset] = useState<HrPeriodPreset>('total');
  const [customIds, setCustomIds] = useState<string[]>([]);

  // Suscripción a la caché: cualquier cambio re-renderiza a todo el módulo.
  useSyncExternalStore(subscribe, getVersion, getVersionServidor);

  const periodIds = useMemo(
    () => periodIdsForPreset(periods, preset, month, customIds),
    [periods, preset, month, customIds],
  );

  // Al cambiar de empresa la caché de la anterior no sirve para nada y además
  // no debe verse: se tira entera.
  const empresaPrevia = useRef(companyId);
  useEffect(() => {
    if (empresaPrevia.current !== companyId) {
      cache.clear();
      enVuelo.clear();
      empresaPrevia.current = companyId;
      notificar();
    }
  }, [companyId]);

  const clave = companyId ? claveDe(companyId, month) : null;
  const entrada = clave ? cache.get(clave) ?? null : null;

  useEffect(() => {
    if (!companyId) return;
    // Cambiar de pestaña NO refetchea: `pedirOverview` corta solo si el mes ya
    // está en la caché o si hay una llamada en vuelo.
    pedirOverview(companyId, month);
  }, [companyId, month]);

  const refetch = useCallback(() => {
    if (!companyId) return;
    cache.delete(claveDe(companyId, month));
    notificar();
    pedirOverview(companyId, month);
  }, [companyId, month]);

  const value = useMemo<HrPeriodValue>(
    () => ({
      month,
      setMonth,
      preset,
      setPreset,
      customIds,
      setCustomIds,
      periodIds,
      overview: entrada?.data ?? null,
      // Sin empresa todavía no se está cargando nada: es "no hay qué pedir".
      loading: !!companyId && entrada === null,
      error: entrada?.error ?? false,
      refetch,
    }),
    [month, preset, customIds, periodIds, entrada, companyId, refetch],
  );

  return <HrPeriodContext.Provider value={value}>{children}</HrPeriodContext.Provider>;
}

/**
 * El reloj del módulo. Falla ruidosamente fuera del provider: una pestaña que
 * se monte por su cuenta con su propio mes es exactamente el problema que esta
 * tanda vino a arreglar.
 */
export function useHrPeriod(): HrPeriodValue {
  const ctx = useContext(HrPeriodContext);
  if (!ctx) throw new Error('useHrPeriod fuera de <HrPeriodProvider>');
  return ctx;
}

/** El mes de un período contable, para las pantallas que muestran su label. */
export { mesDePeriodo };
