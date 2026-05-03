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

export function createClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  cachedClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cachedClient;
}
