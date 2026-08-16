import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  findCompanyByPayprosWebhookToken,
  resolvePayprosCredentials,
} from '@/lib/api-integrations/credentials';
import {
  buildIngoingResponse,
  buildUnparseableResponse,
  parseOutgoing,
  toNormalizedTx,
  verifyOutgoingSignature,
  type PayprosErrorCode,
  type PayprosOutgoing,
  type SignatureVariant,
} from '@/lib/api-integrations/paypros';
import { checkRateLimit, recordFailure, type AttemptKind } from '@/lib/rate-limit';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/paypros/[token]
//
// Webhook de Pay-Pros. Modelo PUSH: NO existe endpoint de listado, así que
// esta ruta es la única fuente de datos del proveedor. Si acá se pierde un
// aviso, la transacción no existe para el dashboard y no hay forma de
// recuperarla. De ahí las tres reglas del handler:
//
//   1. GUARDAR PRIMERO. El body crudo va a `paypros_webhook_events` antes de
//      parsear/verificar nada. Aunque después la firma falle, queda el
//      respaldo para reprocesar a mano.
//   2. RESPONDER SIEMPRE 200 text/plain con el "ingoing string" firmado, en
//      menos de 20 segundos. Pay-Pros necesita ese body; un 500 vacío les
//      parece un fallo de entrega y nos deja sin el aviso. Los errores se
//      comunican por `errorCode` (0 ok / 1 firma / 2 inconsistencia), no por
//      status HTTP.
//   3. IDEMPOTENCIA. Dos niveles:
//        · de entrega: UNIQUE (company_id, notify_reference) en
//          paypros_webhook_events → un reintento devuelve el mismo ingoing OK
//          sin reprocesar.
//        · de datos: upsert en api_transactions por
//          (company_id, provider, external_id = uid).
//
// NO requiere sesión (es una llamada externa). El [token] de la URL es lo
// que identifica al tenant: Pay-Pros no manda el merchant en el cuerpo. El
// token vive en api_credentials.extra_config->>'webhook_token'.
// ─────────────────────────────────────────────────────────────────────────────

// El handler responde en milisegundos; el límite del proveedor es 20 s.
export const maxDuration = 15;

// Rate limit por IP. GENEROSO a propósito: los reintentos legítimos de
// Pay-Pros no se pueden bloquear (perder un aviso = perder plata). 120
// avisos por minuto es varios órdenes de magnitud sobre el tráfico real y
// solo frena un flood deliberado.
const RL_MAX = 120;
const RL_LOCK_MS = 60_000;
// Contador propio en twofa_attempts (kind text sin CHECK): un flood de POSTs
// con firma inválida es un ataque, y el límite es generoso para no rechazar
// los reintentos legítimos de Pay-Pros.
const RL_KIND: AttemptKind = 'paypros-webhook';

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** Toda respuesta al proveedor sale por acá: text/plain, 200, sin cache. */
function textPlain(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function captureSentry(
  message: string,
  extra: Record<string, unknown>,
  level: 'warning' | 'error' = 'error',
): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureMessage(message, { level, tags: { area: 'paypros-webhook' }, extra });
  } catch {
    console.error('[paypros-webhook]', message, extra);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = clientIp(request);

  try {
    const { token } = await params;

    // ── 1. Resolver la empresa por el token de la URL ────────────────────
    // Token desconocido → 404 pelado. No decimos si el token existe pero
    // está mal, ni devolvemos ingoing string: quien no matchea no es
    // Pay-Pros hablando de un tenant nuestro.
    const companyId = await findCompanyByPayprosWebhookToken(token);
    if (!companyId) {
      console.warn(`[paypros-webhook] SECURITY token desconocido desde ip=${ip}`);
      return new NextResponse('Not found', { status: 404 });
    }

    const admin = createAdminClient();

    // ── 2. Rate limit por IP ─────────────────────────────────────────────
    // Se evalúa DESPUÉS de validar el token (un token válido implica que la
    // llamada es plausible) y antes de tocar la DB de eventos.
    const rlOpts = { key: `paypros-ip:${ip}`, kind: RL_KIND };
    const gate = await checkRateLimit(admin, rlOpts);
    if (gate.locked) {
      console.warn(
        `[paypros-webhook] SECURITY rate limit activo ip=${ip} company=${companyId} waitMs=${gate.waitMs}`,
      );
      // 429 sin ingoing string: si estamos bajo flood, no gastamos ciclos
      // firmando respuestas. Pay-Pros reintenta.
      return new NextResponse('Too many requests', { status: 429 });
    }
    await recordFailure(admin, { ...rlOpts, max: RL_MAX, lockMs: RL_LOCK_MS });

    // ── 3. Credenciales del tenant (sign key + api key) ───────────────────
    const creds = await resolvePayprosCredentials(companyId);
    if (!creds) {
      // El token matcheó pero la credencial no está completa/descifrable.
      // Es un error de configuración nuestro, no del proveedor.
      await captureSentry('paypros: credencial incompleta para un token válido', {
        companyId,
        ip,
      });
      return new NextResponse('Not found', { status: 404 });
    }

    // ── 4. Leer el body como TEXTO (no JSON) ─────────────────────────────
    const rawBody = await request.text();

    // ── 5. Parseo (para poder llenar las columnas del evento) ────────────
    const parsed = parseOutgoing(rawBody);

    // ── 6. Guardar el crudo INMEDIATAMENTE ───────────────────────────────
    // Antes de verificar la firma: si el body es basura o la firma falla,
    // igual queremos la evidencia.
    const { data: eventRow, error: insertErr } = await admin
      .from('paypros_webhook_events')
      .insert({
        company_id: companyId,
        raw_body: rawBody,
        remote_ip: ip,
        signature_valid: null,
        notify_reference: parsed?.notifyReference ?? null,
        uid: parsed?.uid ?? null,
        status_code: parsed?.status ?? null,
      })
      .select('id')
      .maybeSingle<{ id: string }>();

    if (insertErr) {
      // 23505 = unique_violation → reintento de una notificación ya recibida.
      // La firma se verifica IGUAL antes de responder OK: un reintento
      // legítimo de Pay-Pros siempre viene firmado, y sin este chequeo
      // cualquiera que conociera un notifyReference real recibiría un
      // "0 = todo bien" con un body inventado (lo destapó el smoke test:
      // firma falsa + notifyReference repetido devolvía errorCode 0).
      if (insertErr.code === '23505' && parsed) {
        const retryCheck = verifyOutgoingSignature(parsed, creds.signKey);
        if (!retryCheck.valid) {
          console.warn(
            `[paypros-webhook] SECURITY reintento con firma inválida company=${companyId} ip=${ip} notifyReference=${parsed.notifyReference}`,
          );
          return textPlain(buildIngoingResponse(1, parsed, creds.signKey, creds.apiKey));
        }
        console.log(
          `[paypros-webhook] reintento de notifyReference=${parsed.notifyReference} company=${companyId} — no se reprocesa`,
        );
        return textPlain(buildIngoingResponse(0, parsed, creds.signKey, creds.apiKey));
      }
      // No pudimos ni guardar el crudo: esto es grave (podemos perder el
      // aviso). Lo dejamos en Sentry con el body para reprocesar a mano y
      // respondemos errorCode 2 para que Pay-Pros reintente.
      await captureSentry('paypros: no se pudo guardar el evento crudo', {
        companyId,
        ip,
        dbError: insertErr.message,
        rawBody,
      });
      return textPlain(errorResponse(2, parsed, creds.signKey, creds.apiKey));
    }

    const eventId = eventRow?.id ?? null;

    // ── 7. Body ilegible → errorCode 2 ───────────────────────────────────
    if (!parsed) {
      await markProcessed(eventId, { error: 'body no parseable' });
      console.warn(`[paypros-webhook] body no parseable company=${companyId} ip=${ip}`);
      return textPlain(buildUnparseableResponse(creds.signKey, creds.apiKey));
    }

    // ── 8. Verificar la firma ────────────────────────────────────────────
    const check = verifyOutgoingSignature(parsed, creds.signKey);
    await admin
      .from('paypros_webhook_events')
      .update({ signature_valid: check.valid })
      .eq('id', eventId);

    if (!check.valid) {
      // Un flood de firmas inválidas es un ataque (alguien conoce la URL y
      // está probando payloads). Se loguea fuerte y NO se procesa nada.
      console.warn(
        `[paypros-webhook] SECURITY firma inválida company=${companyId} ip=${ip} notifyReference=${parsed.notifyReference} uid=${parsed.uid}`,
      );
      await captureSentry(
        'paypros: firma inválida en webhook',
        { companyId, ip, notifyReference: parsed.notifyReference, uid: parsed.uid },
        'warning',
      );
      await markProcessed(eventId, { error: 'firma inválida' });
      return textPlain(buildIngoingResponse(1, parsed, creds.signKey, creds.apiKey));
    }

    // ── 9. Normalizar y persistir ────────────────────────────────────────
    const tx = toNormalizedTx(parsed);
    if (!tx) {
      await markProcessed(eventId, { error: 'datetime inválido' });
      return textPlain(signedWith(2, parsed, creds.signKey, creds.apiKey, check.variant));
    }

    const { error: upsertErr } = await admin.from('api_transactions').upsert(
      {
        company_id: companyId,
        provider: tx.provider,
        external_id: tx.external_id,
        amount: tx.amount,
        fee: tx.fee,
        currency: tx.currency,
        status: tx.status,
        transaction_date: tx.transaction_date,
        raw: { ...tx.raw, notifyReference: parsed.notifyReference },
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,provider,external_id' },
    );

    if (upsertErr) {
      await captureSentry('paypros: upsert de api_transactions falló', {
        companyId,
        uid: parsed.uid,
        notifyReference: parsed.notifyReference,
        dbError: upsertErr.message,
      });
      await markProcessed(eventId, { error: `upsert: ${upsertErr.message}` });
      // errorCode 2 → Pay-Pros reintenta. El reintento chocará con el UNIQUE
      // de la tabla de eventos y devolverá OK sin reprocesar, así que el
      // reproceso real queda a cargo del operador con el crudo guardado.
      return textPlain(signedWith(2, parsed, creds.signKey, creds.apiKey, check.variant));
    }

    await markProcessed(eventId, { processed: true });

    // La respuesta se firma con la MISMA variante de concatenación con la
    // que validó la firma entrante (ver protocol.ts): es la lectura de la
    // doc que usa este merchant.
    return textPlain(signedWith(0, parsed, creds.signKey, creds.apiKey, check.variant));
  } catch (err) {
    // Nunca un 500 vacío: sin body firmado Pay-Pros no puede cerrar la
    // entrega. Como acá no tenemos garantía de tener credenciales, sí puede
    // caer en un 500 si el fallo fue antes de resolverlas.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[paypros-webhook] error no controlado:', msg);
    await captureSentry('paypros: error no controlado en el webhook', { ip, message: msg });
    return new NextResponse('Error', { status: 500 });
  }
}

/** Marca el evento como cerrado. Nunca lanza: es telemetría, no el flujo. */
async function markProcessed(
  eventId: string | null,
  opts: { processed?: boolean; error?: string },
): Promise<void> {
  if (!eventId) return;
  try {
    const admin = createAdminClient();
    await admin
      .from('paypros_webhook_events')
      .update({
        processed_at: new Date().toISOString(),
        error: opts.error ?? null,
      })
      .eq('id', eventId);
  } catch (err) {
    console.error('[paypros-webhook] markProcessed falló:', err);
  }
}

/** Ingoing firmado con una variante concreta. */
function signedWith(
  code: PayprosErrorCode,
  parsed: PayprosOutgoing,
  signKey: string,
  apiKey: string,
  variant: SignatureVariant | null,
): string {
  return variant
    ? buildIngoingResponse(code, parsed, signKey, apiKey, variant)
    : buildIngoingResponse(code, parsed, signKey, apiKey);
}

/** Ingoing de error tolerando que el body no haya parseado. */
function errorResponse(
  code: PayprosErrorCode,
  parsed: PayprosOutgoing | null,
  signKey: string,
  apiKey: string,
): string {
  return parsed
    ? buildIngoingResponse(code, parsed, signKey, apiKey)
    : buildUnparseableResponse(signKey, apiKey);
}
