import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

// Singleton — Kevin (2026-05-03): la página se quedaba colgada en
// "Cargando…" con el warning de gotrue-js:
//   Lock "lock:sb-krohysnnppwcetdjhyyz-auth-token" was not released
//   within 5000ms. … Forcefully acquiring the lock to recover.
//
// La causa: 6 módulos distintos llamaban a createClient() y cada uno
// instanciaba su propio createBrowserClient. Todos comparten la misma
// storage key en localStorage y compiten por el mismo navigator.locks
// lock para refrescar el auth token. Con React Strict Mode (mount-
// unmount-mount en dev) o con dos refrescos paralelos en producción,
// uno se desmontaba con el lock todavía en uso y dejaba un orphan que
// bloqueaba a los demás 5s — la UI no podía hidratar y se quedaba en
// el splash.
//
// Solución estándar Supabase: un solo BrowserClient por pestaña.
// Cacheamos por módulo y devolvemos siempre la misma instancia.
let cachedClient: SupabaseClient | undefined;

// In-memory async lock that serializes auth token operations.
//
// Why custom — Kevin (2026-06-06): tras borrar cache + cookies en
// Chrome, la página se quedaba en "Cargando…" indefinidamente. La
// causa raíz: @supabase/gotrue-js usa por defecto el navigator.locks
// API para sincronizar el refresh del auth token. ESE API persiste
// locks a nivel de origin storage — un lock huérfano de la sesión
// anterior (cerrada abruptamente, hard-killed la pestaña, browser
// crash) puede sobrevivir al hard-reload y bloquear 5s + cada vez
// que se intenta refrescar el token, generando una cascada de
// timeouts que cuelgan los fetches dependientes de auth.
//
// El singleton ya garantiza que solo hay UNA instancia del cliente
// por pestaña, así que la sincronización inter-instancia que
// navigator.locks provee es innecesaria. Un async-lock in-memory
// basado en Promise chaining hace exactamente lo mismo (serializar
// acceso al refresh token DENTRO de esta pestaña) sin ningún estado
// persistente que pueda quedar huérfano entre sesiones.
// Fix 2026-06-20 — el lock anterior tenía un modo de fallo fatal: si la
// operación de auth (típicamente el refresh del token) NUNCA resolvía
// (fetch colgado por red muerta, wake de laptop, cambio de wifi — fetch en
// browser no tiene timeout por defecto), el `finally` nunca corría, el lock
// nunca se liberaba y TODAS las llamadas a Supabase de la pestaña quedaban
// encoladas para siempre. Síntoma visible: "Guardar todo tardó demasiado
// (>25s)" en cadena hasta recargar la página, con la DB respondiendo en
// <1s. Tres guardas nuevas:
//   1. TIMEOUT DURO alrededor de fn(): un refresh colgado ahora falla a los
//      15s (error recuperable — gotrue reintenta) en vez de colgar todo.
//   2. Espera acotada del lock: si el holder anterior no libera en 10s,
//      robamos el lock (mismo espíritu que el "forcefully acquiring" de
//      gotrue con navigator.locks). Peor caso: dos refresh en paralelo —
//      inocuo; el último token escrito gana.
//   3. GC arreglado: la versión anterior comparaba contra una promesa
//      RECIÉN creada (`previous.then(...)` genera un objeto nuevo), así
//      que la condición era siempre false y el map nunca se limpiaba.
type LockFn = <R>(name: string, acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;
const memoryLockMap = new Map<string, Promise<unknown>>();
const LOCK_HOLD_CEILING_MS = 15_000; // máximo que una operación de auth puede retener el lock
const LOCK_ACQUIRE_CEILING_MS = 10_000; // máximo que esperamos por el holder anterior

const memoryLock: LockFn = async (name, acquireTimeout, fn) => {
  const previous = memoryLockMap.get(name) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  memoryLockMap.set(name, chained);

  // Espera al holder anterior, pero NUNCA indefinidamente. acquireTimeout
  // negativo en gotrue significa "espera infinita" — lo acotamos igual:
  // preferimos un refresh duplicado antes que una pestaña muerta.
  const waitMs =
    acquireTimeout >= 0
      ? Math.min(acquireTimeout || LOCK_ACQUIRE_CEILING_MS, LOCK_ACQUIRE_CEILING_MS)
      : LOCK_ACQUIRE_CEILING_MS;
  let acquireTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    previous,
    new Promise<void>((resolve) => {
      acquireTimer = setTimeout(resolve, waitMs);
    }),
  ]).finally(() => clearTimeout(acquireTimer));

  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        holdTimer = setTimeout(
          () =>
            reject(
              new Error(
                `Auth lock "${name}" superó ${LOCK_HOLD_CEILING_MS / 1000}s — liberado para no bloquear la pestaña`,
              ),
            ),
          LOCK_HOLD_CEILING_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(holdTimer);
    release();
    if (memoryLockMap.get(name) === chained) {
      memoryLockMap.delete(name);
    }
  }
};

export function createClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  cachedClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        // Override the default navigator.locks-based lock with an
        // in-memory implementation. Safe because we're singleton —
        // no cross-instance contention exists. See block comment above
        // for why navigator.locks was problematic.
        lock: memoryLock,
      },
    },
  );
  return cachedClient;
}
