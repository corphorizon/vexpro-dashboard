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
 * Per-attempt timeout for the critical-stage fetch in DataProvider.
 * 15s = enough margin for a healthy round-trip + a small retry, while
 * surfacing real outages fast enough for the LoadingScreen retry hint
 * (which fires at 5s).
 */
export const LOAD_TIMEOUT_MS = 15_000;

/**
 * Total attempts for the critical-stage fetch. We do not aggressively
 * retry — the watchdog and the user-facing retry button cover failures
 * better than blind background retries.
 */
export const LOAD_MAX_RETRIES = 2;

/**
 * Absolute fail-safe in DataProvider. If the critical stage hasn't
 * settled within this window, force `loading=false + error` so the
 * user always has an escape hatch.
 */
export const LOAD_WATCHDOG_MS = 35_000;

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
 */
export const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ─── External API tokens ────────────────────────────────────────────────────

/**
 * How long to cache a UniPayment / FairPay / Coinsbuy JWT before
 * re-requesting. 50min on a 60min token = 10min safety margin so a
 * request never starts with an about-to-expire token.
 */
export const EXTERNAL_TOKEN_TTL_MS = 50 * 60 * 1000;
