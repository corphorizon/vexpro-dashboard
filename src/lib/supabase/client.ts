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
type LockFn = <R>(name: string, acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;
const memoryLockMap = new Map<string, Promise<unknown>>();
const memoryLock: LockFn = async (name, _acquireTimeout, fn) => {
  const previous = memoryLockMap.get(name) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  memoryLockMap.set(name, previous.then(() => next));
  await previous; // wait for the previous holder of this name
  try {
    return await fn();
  } finally {
    release();
    // GC the map entry if this was the last one (avoid leaks across
    // long-lived sessions).
    if (memoryLockMap.get(name) === previous.then(() => next)) {
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
