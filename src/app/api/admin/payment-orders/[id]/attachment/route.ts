import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { ORDER_COLUMNS, actorName, normalizeOrder } from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// /api/admin/payment-orders/[id]/attachment — documento de RESPALDO (OPCIONAL).
//
// OJO: NO confundir con el comprobante de pago (../proof). Son dos adjuntos
// distintos y deliberadamente separados:
//   · proof      → prueba de que el pago SE HIZO (captura/PDF del banco). Se
//                  adjunta al marcar pagada. Bucket `payment-proofs`.
//   · attachment → documento que JUSTIFICA la orden (factura del proveedor,
//                  contrato, cotización). Se adjunta al emitirla, junto al
//                  concepto. Bucket `payment-attachments`.
//
// Mismas reglas de ciclo de vida que el comprobante: metadata operativa, no
// contenido económico. El trigger payment_orders_guard congela total/subtotal/
// fees/lines/currency/beneficiario/medio de pago/wallet/cuenta/order_number —
// las columnas attachment_* NO están en esa lista, así que una orden aprobada o
// pagada sigue admitiendo que se adjunte o se corrija el respaldo. Solo se
// bloquea sobre órdenes anuladas (documento cerrado).
//
// SEGURIDAD (mismo patrón que ../proof y que los contratos de RRHH): bucket
// PRIVADO, en la DB se guarda el PATH (nunca una URL pública permanente) y la
// lectura pasa por el GET de esta ruta, que valida sesión + empresa y emite una
// URL FIRMADA corta.
// ---------------------------------------------------------------------------

const BUCKET = 'payment-attachments';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'xlsx'];
/** Vida de la URL firmada: alcanza para abrir/descargar, corta para compartir. */
const SIGNED_TTL_SECONDS = 600;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Sniffed {
  ext: string;
  mime: string;
  /** true = contenedor ZIP de Office: los bytes NO distinguen docx de xlsx. */
  office?: boolean;
}

/**
 * Chequeo de magic bytes server-side. La extensión y el Content-Type son los
 * dos falsificables por el cliente: lo único confiable son los primeros bytes.
 * Mismo criterio que sniffProof() en ../proof y sniffContract() en
 * /api/admin/upload-contract.
 */
function sniffAttachment(bytes: Uint8Array): Sniffed | null {
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
  // DOCX / XLSX: los dos son un ZIP y arrancan con el local file header
  // PK\x03\x04 — por bytes son indistinguibles. Se acepta como "Office
  // genérico" y cuál de los dos es lo resuelve después la extensión declarada,
  // que para entonces ya pasó la allowlist (solo decide nombre y Content-Type,
  // nunca si el archivo entra).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04
  ) {
    return { ext: 'docx', mime: DOCX_MIME, office: true };
  }
  return null;
}

interface AttachmentRow {
  id: string;
  order_number: string;
  status: string;
  attachment_path: string | null;
  attachment_name: string | null;
}

/** Lee la orden con scope de empresa (anti-IDOR: el admin client bypassa RLS). */
async function loadOrder(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  companyId: string,
): Promise<AttachmentRow | null> {
  const { data } = await admin
    .from('payment_orders')
    .select('id, order_number, status, attachment_path, attachment_name')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  return (data as AttachmentRow | null) ?? null;
}

/** Borra el archivo anterior del bucket. Best effort: nunca rompe el request. */
async function removeStored(
  admin: ReturnType<typeof createAdminClient>,
  path: string | null,
): Promise<void> {
  if (!path) return;
  try {
    const { error } = await admin.storage.from(BUCKET).remove([path]);
    if (error) console.error('[payment-orders/attachment] borrado del archivo previo:', error.message);
  } catch (err) {
    console.error('[payment-orders/attachment] borrado del archivo previo:', err);
  }
}

// ── POST — subir / reemplazar el documento de respaldo ──────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
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
        { success: false, error: 'Una orden anulada no admite documentos de respaldo.' },
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
    const sniffed = sniffAttachment(buf);
    if (!sniffed) {
      return NextResponse.json(
        {
          success: false,
          error: 'El archivo no es un documento válido (PDF, PNG, JPG, WEBP, DOCX o XLSX)',
        },
        { status: 400 },
      );
    }

    // Para el ZIP de Office los bytes no alcanzan: si el usuario declaró .xlsx
    // se guarda como planilla, en cualquier otro caso queda como documento.
    const stored =
      sniffed.office && ext === 'xlsx'
        ? { ext: 'xlsx', mime: XLSX_MIME }
        : { ext: sniffed.ext, mime: sniffed.mime };

    // Path con la empresa adelante: cada tenant queda en su propio prefijo.
    // La extensión sale del sniff, no del nombre subido.
    const path = `${companyId}/${order.id}-${Date.now()}.${stored.ext}`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: stored.mime, upsert: false });

    if (uploadError) {
      return apiError('admin/payment-orders/attachment:upload', uploadError, {
        status: 400,
        clientMessage: 'No se pudo subir el documento de respaldo',
      });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await admin
      .from('payment_orders')
      .update({
        attachment_path: path,
        attachment_name: file.name.slice(0, 200),
        attachment_mime: stored.mime,
        attachment_size: file.size,
        attachment_uploaded_at: now,
      })
      .eq('id', order.id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (updateError || !updated) {
      // La fila no quedó apuntando al archivo → no dejar el huérfano en storage.
      await removeStored(admin, path);
      return apiError('admin/payment-orders/attachment:update', updateError, {
        status: 500,
        clientMessage: 'No se pudo guardar el documento en la orden',
      });
    }

    // Recién ahora se borra el anterior: si algo falló antes, el viejo sigue ahí.
    await removeStored(admin, order.attachment_path);

    const result = normalizeOrder(updated as Record<string, unknown>);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: documento de respaldo adjuntado (${file.name})`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/attachment:POST', err, { status: 500 });
  }
}

// ── GET — redirect 302 a una URL firmada de 10 minutos ──────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();

    const order = await loadOrder(admin, id, auth.companyId);
    if (!order?.attachment_path) {
      return NextResponse.json(
        { success: false, error: 'Esta orden no tiene documento de respaldo' },
        { status: 404 },
      );
    }

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(order.attachment_path, SIGNED_TTL_SECONDS);

    if (error || !signed) {
      return apiError('admin/payment-orders/attachment:sign', error, {
        status: 500,
        clientMessage: 'No se pudo generar el enlace del documento',
      });
    }

    // Redirect: así un <a href> abre el archivo con un click (la cookie de
    // sesión viaja en la navegación) sin exponer nunca el path del bucket.
    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (err) {
    return apiError('admin/payment-orders/attachment:GET', err, { status: 500 });
  }
}

// ── DELETE — quitar el documento de respaldo ────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
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
        { success: false, error: 'Una orden anulada no admite cambios en el documento de respaldo.' },
        { status: 400 },
      );
    }
    if (!order.attachment_path) {
      return NextResponse.json(
        { success: false, error: 'Esta orden no tiene documento de respaldo' },
        { status: 404 },
      );
    }

    const { data: updated, error: updateError } = await admin
      .from('payment_orders')
      .update({
        attachment_path: null,
        attachment_name: null,
        attachment_mime: null,
        attachment_size: null,
        attachment_uploaded_at: null,
      })
      .eq('id', order.id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (updateError || !updated) {
      return apiError('admin/payment-orders/attachment:clear', updateError, {
        status: 500,
        clientMessage: 'No se pudo quitar el documento de respaldo',
      });
    }

    // La fila ya no lo referencia; el archivo se borra best effort.
    await removeStored(admin, order.attachment_path);

    const result = normalizeOrder(updated as Record<string, unknown>);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: documento de respaldo eliminado${order.attachment_name ? ` (${order.attachment_name})` : ''}`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/attachment:DELETE', err, { status: 500 });
  }
}
