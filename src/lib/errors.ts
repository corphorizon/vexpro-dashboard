// ─────────────────────────────────────────────────────────────────────────────
// Error sanitizer — never leak Postgres/Supabase internals to clients.
//
// Audit SEC-A1 finding: several /api/admin and /api/superadmin routes were
// returning `error: error.message` straight from Supabase, which exposes:
//   · table names and column names (`company_users`, `api_credentials`)
//   · constraint names (`api_credentials_unique`, `custom_roles_pkey`)
//   · query fragments in RLS failures
//
// This helper maps common PostgresError codes to user-friendly Spanish copy
// and returns the raw error unchanged ONLY to server-side logs.
//
// Usage:
//
//   import { sanitizeDbError } from '@/lib/errors';
//   ...
//   const { error } = await admin.from('x').insert(...);
//   if (error) {
//     return NextResponse.json(sanitizeDbError(error), { status: 500 });
//   }
//
// The returned object has the shape { success: false, error: string } so
// it's drop-in compatible with existing route response conventions. The
// helper also writes the full error to stderr with a stable prefix so
// operators can grep Vercel logs for the real cause.
// ─────────────────────────────────────────────────────────────────────────────

// PostgresError shape — we only need the fields actually used to decide.
interface PostgresLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

type UnknownError = unknown;

const GENERIC_MESSAGE = 'Error al procesar la solicitud';

// https://www.postgresql.org/docs/current/errcodes-appendix.html
// Maps the handful we actually hit to user-friendly copy.
const POSTGRES_ERROR_MAP: Record<string, string> = {
  // Integrity constraint violations
  '23505': 'Ya existe un registro con esos datos',           // unique_violation
  '23503': 'Referencia inválida — el dato relacionado no existe', // foreign_key_violation
  '23502': 'Falta un campo obligatorio',                     // not_null_violation
  '23514': 'Los datos no cumplen las reglas de validación',  // check_violation

  // Data type issues
  '22P02': 'El formato de los datos es inválido',            // invalid_text_representation
  '22001': 'El valor es demasiado largo',                    // string_data_right_truncation

  // Transaction / concurrency
  '40001': 'Otro cambio modificó el registro — intenta de nuevo', // serialization_failure
  '40P01': 'Conflicto de escritura — intenta de nuevo',      // deadlock_detected

  // RLS / permission
  '42501': 'No tienes permisos para esta operación',         // insufficient_privilege
  'PGRST301': 'No tienes acceso a este recurso',             // PostgREST RLS error

  // Not found
  'PGRST116': 'Registro no encontrado',                      // PostgREST no rows
};

/**
 * Returns a safe `{ success: false, error: string }` payload suitable for
 * returning directly from an API route. Always logs the underlying error
 * to stderr with a stable prefix `[db-error]` so operators can correlate.
 */
export function sanitizeDbError(
  err: UnknownError,
  context?: string,
): { success: false; error: string } {
  // Always log the real error — stderr is private to the server.
  const prefix = context ? `[db-error ${context}]` : '[db-error]';
  console.error(prefix, err);

  if (err && typeof err === 'object') {
    const pg = err as PostgresLikeError;
    if (pg.code && POSTGRES_ERROR_MAP[pg.code]) {
      return { success: false, error: POSTGRES_ERROR_MAP[pg.code] };
    }
    // Well-formed Error instances without a pg code get a neutral string
    // too — never return err.message because that's where table/constraint
    // names leak.
  }

  return { success: false, error: GENERIC_MESSAGE };
}

/**
 * Sanitizer for unexpected non-DB exceptions (network, parsing, etc.).
 * Returns the same shape as sanitizeDbError so routes can use either.
 */
export function sanitizeError(
  err: UnknownError,
  context?: string,
): { success: false; error: string } {
  const prefix = context ? `[error ${context}]` : '[error]';
  console.error(prefix, err);
  return { success: false, error: GENERIC_MESSAGE };
}
