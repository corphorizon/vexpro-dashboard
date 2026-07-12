// ─────────────────────────────────────────────────────────────────────────────
// apiError — respuesta de error de API que NO filtra internos al cliente.
//
// SEC-03 (auditoría 2026-07-12): decenas de rutas devolvían el `error.message`
// crudo de PostgREST/Supabase al frontend (nombres de columnas, constraints,
// hints de RLS) → divulgación de la estructura interna de la DB. Este helper
// centraliza el patrón correcto:
//   · loguea el detalle REAL server-side (console + Sentry) para poder debuggear,
//   · devuelve al cliente un mensaje GENÉRICO (o uno propio, no sensible) +
//     un status estable. Nunca el string crudo del error de la DB.
//
// Uso:
//   const { error } = await admin.from('x').insert(...);
//   if (error) return apiError('admin/x POST', error, { status: 500 });
//
//   } catch (err) {
//     return apiError('admin/x POST', err, { status: 500 });
//   }
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { friendlyDbMessage } from '@/lib/errors';

interface ApiErrorOptions {
  /** Status HTTP (default 500). */
  status?: number;
  /** Mensaje mostrado al cliente (no sensible). Default genérico. */
  clientMessage?: string;
  /** false → body `{ error }` (sin flag). Default true → `{ success: false, error }`. */
  withSuccessFlag?: boolean;
  /** Contexto extra para Sentry (ids, no secretos). */
  extra?: Record<string, unknown>;
}

export function apiError(
  logContext: string,
  rawError: unknown,
  opts: ApiErrorOptions = {},
): NextResponse {
  const status = opts.status ?? 500;
  const detail =
    rawError instanceof Error
      ? rawError.message
      : typeof rawError === 'object' && rawError !== null && 'message' in rawError
        ? String((rawError as { message: unknown }).message)
        : String(rawError);

  // Detalle real solo del lado del servidor.
  console.error(`[api:${logContext}] ${detail}`);
  Sentry.captureException(
    rawError instanceof Error ? rawError : new Error(`${logContext}: ${detail}`),
    { tags: { area: `api.${logContext}` }, extra: opts.extra },
  );

  // Mensaje amistoso: el override del caller, o el mapeo canónico de códigos
  // Postgres (@/lib/errors) — nunca el string crudo del error.
  const message = opts.clientMessage ?? friendlyDbMessage(rawError);
  const body =
    opts.withSuccessFlag === false
      ? { error: message }
      : { success: false, error: message };

  return NextResponse.json(body, { status });
}
