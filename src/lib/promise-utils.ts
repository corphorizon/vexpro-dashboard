// ─────────────────────────────────────────────────────────────────────────────
// promise-utils — small, dependency-free helpers around Promises.
//
// Use `withTimeout` to bound any awaited call (Supabase fetch, REST request,
// etc.) so a hung network or a stalled RLS evaluation can't leave a UI in
// "loading forever". When the deadline elapses the returned promise rejects
// with `TimeoutError`, which the caller can detect with `instanceof` and
// surface as a user-friendly message.
//
// The wrapper does NOT cancel the underlying work — JavaScript promises are
// not cancellable. It only races the original promise against the timer so
// the UI can move on. The orphaned operation will still complete in the
// background but its result is ignored.
// ─────────────────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(ms: number, label?: string) {
    super(
      label
        ? `${label} excedió el tiempo de espera (${(ms / 1000).toFixed(0)}s)`
        : `Operación abortada por timeout (${(ms / 1000).toFixed(0)}s)`,
    );
    this.name = 'TimeoutError';
    this.elapsedMs = ms;
  }
}

/**
 * Race a promise against a timer.
 *
 * @param promise The work to await.
 * @param ms Deadline in milliseconds. Defaults to 10_000.
 * @param label Optional human-readable label used in the error message.
 *
 * @example
 *   try {
 *     await withTimeout(fetch('/api/save', { ... }), 10_000, 'Guardar balance');
 *   } catch (err) {
 *     if (err instanceof TimeoutError) {
 *       setError('La operación tardó demasiado. Reintentá o avisá a soporte.');
 *     } else {
 *       setError(err instanceof Error ? err.message : 'Error desconocido');
 *     }
 *   }
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = 10_000,
  label?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
