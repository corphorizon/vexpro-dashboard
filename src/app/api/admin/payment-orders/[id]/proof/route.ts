import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { ORDER_COLUMNS, actorName, normalizeOrder } from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// /api/admin/payment-orders/[id]/proof — comprobante de pago (OPCIONAL).
//
// Metadato operativo, no contenido económico: la orden ya lleva la referencia
// (txid / referencia bancaria) como dato obligatorio del pago; el comprobante
// es la captura o el PDF del banco que lo respalda. Por eso:
//   · Nunca es obligatorio: marcar pagada NUNCA depende de que suba el archivo.
//   · Se puede adjuntar, reemplazar o quitar incluso con la orden ya pagada —
//     corregir un comprobante mal subido no toca el contenido inmutable. El
//     trigger payment_orders_guard congela total/subtotal/fees/lines/currency/
//     beneficiario/medio de pago/wallet/cuenta/order_number; las columnas
//     payment_proof_* NO están en esa lista, así que estos updates pasan.
//   · Solo se bloquea sobre órdenes anuladas (documento cerrado).
//
// SEGURIDAD (mismo patrón que contratos de RRHH, S2): bucket PRIVADO, en la DB
// se guarda el PATH (nunca una URL pública permanente) y la lectura pasa por el
// GET de esta ruta, que valida sesión + empresa y emite una URL FIRMADA corta.
// ---------------------------------------------------------------------------

const BUCKET = 'payment-proofs';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
/** Vida de la URL firmada: alcanza para abrir/descargar, corta para compartir. */
const SIGNED_TTL_SECONDS = 600;

/**
 * Chequeo de magic bytes server-side. La extensión y el Content-Type son los
 * dos falsificables por el cliente: lo único confiable son los primeros bytes.
 * Mismo criterio que sniffContract() en /api/admin/upload-contract.
 */
function sniffProof(bytes: Uint8Array): { ext: string; mime: string } | null {
  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  ) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // WEBP: contenedor RIFF — "RIFF" en 0-3 y "WEBP" en 8-11 (4-7 es el tamaño).
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

interface ProofRow {
  id: string;
  order_number: string;
  status: string;
  payment_proof_path: string | null;
  payment_proof_name: string | null;
}

/** Lee la orden con scope de empresa (anti-IDOR: el admin client bypassa RLS). */
async function loadOrder(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  companyId: string,
): Promise<ProofRow | null> {
  const { data } = await admin
    .from('payment_orders')
    .select('id, order_number, status, payment_proof_path, payment_proof_name')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  return (data as ProofRow | null) ?? null;
}

/** Borra el archivo anterior del bucket. Best effort: nunca rompe el request. */
async function removeStored(
  admin: ReturnType<typeof createAdminClient>,
  path: string | null,
): Promise<void> {
  if (!path) return;
  try {
    const { error } = await admin.storage.from(BUCKET).remove([path]);
    if (error) console.error('[payment-orders/proof] borrado del archivo previo:', error.message);
  } catch (err) {
    console.error('[payment-orders/proof] borrado del archivo previo:', err);
  }
}

// ── POST — subir / reemplazar el comprobante ────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();
    const companyId = auth.companyId;

    const order = await loadOrder(admin, id, companyId);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }
    if (order.status === 'cancelled') {
      return NextResponse.json(
        { success: false, error: 'Una orden anulada no admite comprobantes.' },
        { status: 400 },
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { success: false, error: 'No se recibió ningún archivo.' },
        { status: 400 },
      );
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'Archivo demasiado grande (máx 10 MB)' },
        { status: 400 },
      );
    }

    // Primera pasada barata por extensión…
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { success: false, error: `Tipo de archivo no permitido. Solo: ${ALLOWED_EXTENSIONS.join(', ')}` },
        { status: 400 },
      );
    }

    // …y el control que manda: los bytes reales.
    const buf = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffProof(buf);
    if (!sniffed) {
      return NextResponse.json(
        { success: false, error: 'El archivo no es un comprobante válido (PDF, PNG, JPG o WEBP)' },
        { status: 400 },
      );
    }

    // Path con la empresa adelante: cada tenant queda en su propio prefijo.
    // La extensión sale del sniff, no del nombre subido.
    const path = `${companyId}/${order.id}-${Date.now()}.${sniffed.ext}`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: sniffed.mime, upsert: false });

    if (uploadError) {
      return apiError('admin/payment-orders/proof:upload', uploadError, {
        status: 400,
        clientMessage: 'No se pudo subir el comprobante',
      });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await admin
      .from('payment_orders')
      .update({
        payment_proof_path: path,
        payment_proof_name: file.name.slice(0, 200),
        payment_proof_mime: sniffed.mime,
        payment_proof_size: file.size,
        payment_proof_uploaded_at: now,
      })
      .eq('id', order.id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (updateError || !updated) {
      // La fila no quedó apuntando al archivo → no dejar el huérfano en storage.
      await removeStored(admin, path);
      return apiError('admin/payment-orders/proof:update', updateError, {
        status: 500,
        clientMessage: 'No se pudo guardar el comprobante en la orden',
      });
    }

    // Recién ahora se borra el anterior: si algo falló antes, el viejo sigue ahí.
    await removeStored(admin, order.payment_proof_path);

    const result = normalizeOrder(updated as Record<string, unknown>);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: comprobante de pago adjuntado (${file.name})`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/proof:POST', err, { status: 500 });
  }
}

// ── GET — redirect 302 a una URL firmada de 10 minutos ──────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();

    const order = await loadOrder(admin, id, auth.companyId);
    if (!order?.payment_proof_path) {
      return NextResponse.json(
        { success: false, error: 'Esta orden no tiene comprobante' },
        { status: 404 },
      );
    }

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(order.payment_proof_path, SIGNED_TTL_SECONDS);

    if (error || !signed) {
      return apiError('admin/payment-orders/proof:sign', error, {
        status: 500,
        clientMessage: 'No se pudo generar el enlace del comprobante',
      });
    }

    // Redirect: así un <a href> abre el archivo con un click (la cookie de
    // sesión viaja en la navegación) sin exponer nunca el path del bucket.
    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (err) {
    return apiError('admin/payment-orders/proof:GET', err, { status: 500 });
  }
}

// ── DELETE — quitar el comprobante ──────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();
    const companyId = auth.companyId;

    const order = await loadOrder(admin, id, companyId);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }
    if (order.status === 'cancelled') {
      return NextResponse.json(
        { success: false, error: 'Una orden anulada no admite cambios en el comprobante.' },
        { status: 400 },
      );
    }
    if (!order.payment_proof_path) {
      return NextResponse.json(
        { success: false, error: 'Esta orden no tiene comprobante' },
        { status: 404 },
      );
    }

    const { data: updated, error: updateError } = await admin
      .from('payment_orders')
      .update({
        payment_proof_path: null,
        payment_proof_name: null,
        payment_proof_mime: null,
        payment_proof_size: null,
        payment_proof_uploaded_at: null,
      })
      .eq('id', order.id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (updateError || !updated) {
      return apiError('admin/payment-orders/proof:clear', updateError, {
        status: 500,
        clientMessage: 'No se pudo quitar el comprobante',
      });
    }

    // La fila ya no lo referencia; el archivo se borra best effort.
    await removeStored(admin, order.payment_proof_path);

    const result = normalizeOrder(updated as Record<string, unknown>);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: comprobante de pago eliminado${order.payment_proof_name ? ` (${order.payment_proof_name})` : ''}`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/proof:DELETE', err, { status: 500 });
  }
}
