/**
 * Centralized runtime configuration.
 *
 * Magic numbers that used to be scattered across files (LOAD_TIMEOUT_MS,
 * MAX_RETRIES, TOKEN_TTL_MS, etc.) live here so that:
 *   - Tuning them no longer means grepping the codebase.
 *   - The pattern of "Kevin reported it's too slow / too fast" can be
 *     resolved with a single PR.
 *   - Tests can override individual values without monkey-patching the
 *     source files.
 *
 * Kept TYPESCRIPT-only and CLIENT-SAFE: nothing here reads process.env
 * directly, so it can be imported from server + browser code without
 * a build-time leak. Server-only secrets live in `src/lib/env.ts`.
 */

// ─── Data layer / DataProvider ───────────────────────────────────────────────

/**
 * Timeout de la ruta /api/bootstrap — el camino PRIMARIO del arranque.
 *
 * Es UN fetch que trae los 20 slices del boot. 15s da margen para un
 * round-trip desde LatAm/Dubái (RTT medido 250-350ms) más el trabajo del
 * servidor, sin dejar al usuario mirando el splash medio minuto.
 */
export const LOAD_BOOTSTRAP_TIMEOUT_MS = 15_000;

/**
 * Timeout POR INTENTO del camino de FALLBACK (las 20 consultas directas a
 * PostgREST desde el navegador).
 *
 * ── Por qué bajó de 15s a 8s (2026-08-28) ─────────────────────────────────
 * El timeout viejo (15s) no abortaba nada: era un `Promise.race` contra un
 * `setTimeout` y los fetch de supabase-js seguían vivos. Con MAX_RETRIES=2 el
 * usuario esperaba 15 + 1,5 + 15 = 31,5s antes de ver el error, y el segundo
 * intento salía sobre la MISMA conexión muerta que ya había fallado.
 *
 * Ahora cada intento lleva su propio AbortController (ver
 * src/lib/supabase/queries.ts): al vencer se aborta de verdad y el reintento
 * arranca con señal nueva. Presupuesto visible del fallback: 8s × 1 intento.
 */
export const LOAD_TIMEOUT_MS = 8_000;

/**
 * Intentos totales del camino de fallback. 1 = un solo intento.
 *
 * Bajó de 2 a 1 el 2026-08-28: reintentar sin abortar el fetch anterior sólo
 * sumaba 16,5s de espera sobre una conexión ya muerta. El camino primario
 * (/api/bootstrap) ya es un intento propio, así que el usuario sigue teniendo
 * dos oportunidades — por dos caminos distintos, no dos veces el mismo.
 */
export const LOAD_MAX_RETRIES = 1;

/**
 * Absolute fail-safe in DataProvider. If the critical stage hasn't
 * settled within this window, force `loading=false + error` so the
 * user always has an escape hatch.
 *
 * Tiene que ser MAYOR que el peor caso real del arranque:
 * LOAD_BOOTSTRAP_TIMEOUT_MS (15s) + LOAD_TIMEOUT_MS (8s) = 23s. 30s deja
 * 7s de margen sin volver a los 35s de antes.
 */
export const LOAD_WATCHDOG_MS = 30_000;

/**
 * After this delay, LoadingScreen surfaces the "Está tardando…" hint
 * and a "Reintentar ahora" button. Independent of LOAD_TIMEOUT_MS so a
 * fast network sees no hint at all.
 */
export const LOAD_SLOW_HINT_MS = 5_000;

// ─── Upload page row-level mutations ────────────────────────────────────────

/**
 * Hard ceiling around each per-row mutation in /upload (Liquidez,
 * Inversiones, single-cell saves on Depósitos/Retiros). Beyond this
 * we surface a clear "tardó demasiado" instead of letting the UI hang.
 * 25s was tuned after Kevin reported that 10s gave false positives on
 * healthy writes (auth refresh + retry can take ~15s).
 */
export const ROW_MUTATION_TIMEOUT_MS = 25_000;

/**
 * Hard ceiling for the multi-mutation "Guardar todo" path. Same value
 * as ROW_MUTATION_TIMEOUT_MS for consistency — the user shouldn't see
 * different timeouts for similar actions.
 */
export const BATCH_SAVE_TIMEOUT_MS = 25_000;

// ─── Auth / sessions ────────────────────────────────────────────────────────

/**
 * Inactivity window before the client automatically signs the user
 * out. 2h matches the historic value but is now configurable.
 *
 * ÚNICA copia. Hasta el 2026-08-28 auth-context.tsx tenía su propio
 * `INACTIVITY_MS = 2 * 60 * 60 * 1000` y esta constante no la leía NADIE:
 * dos números gemelos que nadie sincronizaba — el modo de falla número uno
 * del repo (ver docs/reglas-del-proyecto.md §1.1). Ahora auth-context importa
 * de acá.
 */
export const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ─── Lock de auth de supabase-js ────────────────────────────────────────────

/**
 * Techo que una operación de auth (típicamente el refresh del token) puede
 * retener el lock in-memory de src/lib/supabase/client.ts.
 *
 * ── Por qué NO puede valer lo mismo que ningún timeout de carga ───────────
 * Hasta el 2026-08-28 valía 15_000, EXACTAMENTE igual que LOAD_TIMEOUT_MS.
 * Cuando el lock reventaba su techo, el fallo llegaba al usuario disfrazado
 * de "La carga tardó demasiado" y en telemetría era indistinguible de un
 * fallo de datos: mismo tiempo, mismo mensaje. Nunca supimos cuántos de los
 * arranques fallidos eran en realidad un refresh de token colgado.
 *
 * 6s es deliberadamente distinto de LOAD_TIMEOUT_MS (8s) y de
 * LOAD_BOOTSTRAP_TIMEOUT_MS (15s): si el lock revienta, revienta ANTES y con
 * su propio evento (`[auth-lock] hold-ceiling-exceeded`). El test de
 * config-timeouts.test.ts fija que los tres sigan siendo distintos.
 */
export const AUTH_LOCK_HOLD_CEILING_MS = 6_000;

/** Máximo que esperamos por el holder anterior del lock antes de robarlo. */
export const AUTH_LOCK_ACQUIRE_CEILING_MS = 10_000;

// ─── External API tokens ────────────────────────────────────────────────────

/**
 * How long to cache a UniPayment / FairPay / Coinsbuy JWT before
 * re-requesting. 50min on a 60min token = 10min safety margin so a
 * request never starts with an about-to-expire token.
 */
export const EXTERNAL_TOKEN_TTL_MS = 50 * 60 * 1000;
