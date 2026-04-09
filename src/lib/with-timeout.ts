// ─────────────────────────────────────────────────────────────────────────────
// withTimeout
//
// Race any promise against a timer so a hung network call (Supabase cold
// start, dropped socket, stuck RLS evaluation, etc.) can't freeze the UI
// forever. Throws a regular Error when the timer wins — callers handle it
// exactly like any other failure (show toast, reset saving flag, etc.).
// ─────────────────────────────────────────────────────────────────────────────

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Operación tardó más de ${ms / 1000}s`
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
}
