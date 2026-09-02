import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { PAYMENT_ORDER_READ_ROLES } from '@/lib/roles';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { ORDER_COLUMNS, actorName, normalizeOrder, withFiles } from '@/lib/payment-orders/server';
import { attachmentCountError, LEGACY_ATTACHMENT_ID } from '@/lib/payment-orders/types';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_SIZE,
  hasAllowedAttachmentExtension,
  sniffAttachment,
  storedAttachmentType,
} from '@/lib/payment-orders/attachment-files';

// ---------------------------------------------------------------------------
// /api/admin/payment-orders/[id]/attachment — documentos de RESPALDO (OPCIONALES).
//
// OJO: NO confundir con el comprobante de pago (../proof). Son dos adjuntos
// distintos y deliberadamente separados:
//   · proof      → prueba de que el pago SE HIZO (captura/PDF del banco). Se
//                  adjunta al marcar pagada. Bucket `payment-proofs`.
//   · attachment → documento que JUSTIFICA la orden (factura del proveedor,
//                  contrato, cotización). Se adjunta al emitirla, junto al
//                  concepto. Bucket `payment-attachments`.
//
// HASTA MAX_PAYMENT_ATTACHMENTS ARCHIVOS (pedido de Kevin, migración 127)
// Antes había un solo respaldo en cinco columnas de payment_orders y el POST
// REEMPLAZABA al anterior. Ahora cada archivo es una fila de
// payment_order_attachments y el POST AGREGA. Es exactamente el camino que ya
// recorrieron los comprobantes en la 086, así que este endpoint es su gemelo:
// mismas reglas, mismos mensajes, misma forma de respuesta.
//
// COMPATIBILIDAD CON LO VIEJO
// Mientras la migración no esté aplicada (o su backfill no haya alcanzado a una
// orden), el respaldo sigue en las columnas attachment_*. Ese archivo se expone
// como un adjunto más de la lista, con el id sintético LEGACY_ATTACHMENT_ID, y
// se puede ver, descargar y borrar igual que cualquier otro. Sin esto, una
// orden con factura aparecería SIN respaldo y nadie vería un error: el modo de
// falla que este repo persigue.
//
// Mismas reglas de ciclo de vida que el comprobante: metadata operativa, no
// contenido económico. El trigger payment_orders_guard congela total/subtotal/
// fees/lines/currency/beneficiario/medio de pago/wallet/cuenta/order_number —
// los respaldos ni siquiera están en payment_orders, así que una orden aprobada
// o pagada sigue admitiendo que se adjunte o se corrija el respaldo. Solo se
// bloquea sobre órdenes anuladas (documento cerrado).
//
// SEGURIDAD (mismo patrón que ../proof y que los contratos de RRHH): bucket
// PRIVADO, en la DB se guarda el PATH (nunca una URL pública permanente) y la
// lectura pasa por el GET de esta ruta, que valida sesión + empresa y emite una
// URL FIRMADA corta. El path NUNCA sale al cliente: la UI maneja `attachment_id`.
//
// CONTRATO
//   POST   body multipart con uno o varios campos 'file'
//          → 200 { success, order }  — la orden CON `order.attachments` al día
//          → 409 si el total (existentes + nuevos) supera el tope: el mensaje
//            dice cuántos hay y cuál es el máximo (el recorte se avisa, nunca
//            se traga)
//          → 400 si algún archivo no pasa el sniff, pesa más de 10 MB, o la
//            orden está anulada
//   GET    sin query        → 200 { success, attachments: [{ id, file_name,
//                             mime, size, uploaded_at }] }
//          ?attachment_id=X → 302 a una URL firmada de 10 minutos de ESE archivo
//          ?attachment_id=X&download=1 → idem, forzando la descarga
//   DELETE ?attachment_id=X → 200 { success, order } (fila + objeto del bucket)
//          → 400 sin attachment_id (borrar "el respaldo" ya no es una operación
//            bien definida cuando puede haber diez)
// ---------------------------------------------------------------------------

const BUCKET = 'payment-attachments';
/** Vida de la URL firmada: alcanza para abrir/descargar, corta para compartir. */
const SIGNED_TTL_SECONDS = 600;

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  // Columnas LEGADAS (migración 127): solo se leen para el fallback de arriba.
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  attachment_size: number | null;
  attachment_uploaded_at: string | null;
}

/** Fila de la tabla nueva CON el path — server-only. */
interface AttachmentRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  sort_order: number;
}

const LEGACY_COLUMNS =
  'attachment_path, attachment_name, attachment_mime, attachment_size, attachment_uploaded_at';

/** Lee la orden con scope de empresa (anti-IDOR: el admin client bypassa RLS). */
async function loadOrder(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  companyId: string,
): Promise<OrderRow | null> {
  const { data } = await admin
    .from('payment_orders')
    .select(`id, order_number, status, ${LEGACY_COLUMNS}`)
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  return (data as OrderRow | null) ?? null;
}

/**
 * Respaldos guardados, en orden. Incluye el storage_path: server-only.
 *
 * Si la tabla todavía no existe (migración sin aplicar) NO se traga el error:
 * se registra y se devuelve lista vacía, y el caller decide. Para la LECTURA el
 * fallback legado lo resuelve loadOrderAttachments() en server.ts; para el
 * borrado, el id legado se maneja aparte.
 */
async function loadAttachmentRows(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
): Promise<AttachmentRow[]> {
  const { data, error } = await admin
    .from('payment_order_attachments')
    .select('id, storage_path, file_name, sort_order')
    .eq('payment_order_id', orderId)
    .order('sort_order', { ascending: true })
    .order('uploaded_at', { ascending: true });
  if (error) console.error('[payment-orders/attachment] lectura:', error.message);
  return (data ?? []) as AttachmentRow[];
}

/**
 * Cuántos respaldos tiene la orden HOY, contando el legado.
 *
 * Cuenta el archivo de las columnas viejas solo si no hay filas en la tabla:
 * después del backfill ese path YA está representado por una fila y contarlo
 * dos veces le comería un lugar al usuario sin explicación.
 */
function currentCount(rows: AttachmentRow[], order: OrderRow): number {
  if (rows.length > 0) return rows.length;
  return order.attachment_path ? 1 : 0;
}

/** Borra objetos del bucket. Best effort: nunca rompe el request. */
async function removeStored(
  admin: ReturnType<typeof createAdminClient>,
  paths: (string | null)[],
): Promise<void> {
  const list = paths.filter((p): p is string => !!p);
  if (list.length === 0) return;
  try {
    const { error } = await admin.storage.from(BUCKET).remove(list);
    if (error) console.error('[payment-orders/attachment] borrado en storage:', error.message);
  } catch (err) {
    console.error('[payment-orders/attachment] borrado en storage:', err);
  }
}

/** Respuesta estándar de POST/DELETE: la orden completa CON sus archivos. */
async function orderResponse(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
  companyId: string,
) {
  const { data } = await admin
    .from('payment_orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!data) return null;
  return withFiles(admin, normalizeOrder(data as Record<string, unknown>));
}

const notFound = () =>
  NextResponse.json({ success: false, error: 'Orden de pago no encontrada' }, { status: 404 });

// ── POST — agregar uno o varios documentos de respaldo ──────────────────────

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
    if (!order) return notFound();
    if (order.status === 'cancelled') {
      return NextResponse.json(
        { success: false, error: 'Una orden anulada no admite documentos de respaldo.' },
        { status: 400 },
      );
    }

    const formData = await request.formData();
    // getAll: el cliente puede mandar 'file' una o varias veces en el mismo
    // multipart. Un solo archivo sigue funcionando igual que antes.
    const files = formData
      .getAll('file')
      .filter((f): f is File => f instanceof File && f.size > 0);

    // El tope se valida ANTES de tocar el bucket: subir diez archivos para
    // después rechazarlos deja basura y quema ancho de banda del usuario.
    const existing = await loadAttachmentRows(admin, order.id);
    const countMsg = attachmentCountError(currentCount(existing, order), files.length);
    if (countMsg) {
      // 409 y no 400: el archivo está bien, lo que no da es el LUGAR. El
      // mensaje dice cuántos hay y cuántos entran todavía.
      return NextResponse.json(
        { success: false, error: countMsg },
        { status: files.length > 0 ? 409 : 400 },
      );
    }

    // Validación de TODOS los archivos antes de subir NINGUNO: un lote se
    // acepta entero o se rechaza entero (si no, el usuario queda con dos de
    // tres subidos y un error genérico).
    const prepared: { buf: Buffer; ext: string; mime: string; name: string; size: number }[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        return NextResponse.json(
          { success: false, error: `Archivo demasiado grande (máx 10 MB): ${file.name}` },
          { status: 400 },
        );
      }
      // Primera pasada barata por extensión…
      if (!hasAllowedAttachmentExtension(file.name)) {
        return NextResponse.json(
          {
            success: false,
            error: `Tipo de archivo no permitido (${file.name}). Solo: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')}`,
          },
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
            error: `El archivo no es un documento válido (PDF, PNG, JPG, WEBP, DOCX o XLSX): ${file.name}`,
          },
          { status: 400 },
        );
      }
      const stored = storedAttachmentType(sniffed, file.name);
      prepared.push({
        buf,
        ext: stored.ext,
        mime: stored.mime,
        name: file.name.slice(0, 200),
        size: file.size,
      });
    }

    // sort_order continúa la numeración existente para que el archivo nuevo
    // quede al final de la lista y no reordene lo que el usuario ya vio.
    let nextSort = existing.reduce((max, a) => Math.max(max, Number(a.sort_order) || 0), -1) + 1;
    const uploadedPaths: string[] = [];
    const rows: Record<string, unknown>[] = [];

    for (const p of prepared) {
      // Path con la empresa adelante: cada tenant queda en su propio prefijo.
      // La extensión sale del sniff, no del nombre subido. El sufijo aleatorio
      // evita colisiones cuando entran dos archivos en el mismo milisegundo
      // (el esquema viejo usaba solo Date.now() y podía pisarse).
      const path = `${companyId}/${order.id}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${p.ext}`;
      const { error: uploadError } = await admin.storage
        .from(BUCKET)
        .upload(path, p.buf, { contentType: p.mime, upsert: false });

      if (uploadError) {
        // Lote atómico: lo ya subido se limpia antes de contestar el error.
        await removeStored(admin, uploadedPaths);
        return apiError('admin/payment-orders/attachment:upload', uploadError, {
          status: 400,
          clientMessage: `No se pudo subir el documento ${p.name}`,
        });
      }
      uploadedPaths.push(path);
      rows.push({
        company_id: companyId,
        payment_order_id: order.id,
        storage_path: path,
        file_name: p.name,
        mime: p.mime,
        size: p.size,
        uploaded_by: auth.userId,
        sort_order: nextSort++,
      });
    }

    const { error: insertError } = await admin.from('payment_order_attachments').insert(rows);
    if (insertError) {
      // Ninguna fila apunta a los archivos → no dejar huérfanos en storage.
      await removeStored(admin, uploadedPaths);
      return apiError('admin/payment-orders/attachment:insert', insertError, {
        status: 500,
        clientMessage: 'No se pudieron guardar los documentos en la orden',
      });
    }

    const result = await orderResponse(admin, order.id, companyId);
    if (!result) return notFound();

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details:
        `Orden ${result.order_number}: ${rows.length} documento${rows.length === 1 ? '' : 's'} de respaldo adjuntado${rows.length === 1 ? '' : 's'} ` +
        `(${prepared.map((p) => p.name).join(', ')})`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/attachment:POST', err, { status: 500 });
  }
}

// ── GET — lista de respaldos, o redirect 302 a una URL firmada ──────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: PAYMENT_ORDER_READ_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();

    const order = await loadOrder(admin, id, auth.companyId);
    if (!order) return notFound();

    const attachmentId = request.nextUrl.searchParams.get('attachment_id');
    const rows = await loadAttachmentRows(admin, order.id);

    // Sin attachment_id: la lista (sin storage_path — el path no sale al
    // cliente). Con la orden legada, el archivo de las columnas viejas se
    // devuelve como un adjunto más.
    if (!attachmentId) {
      if (rows.length === 0) {
        return NextResponse.json({
          success: true,
          attachments: order.attachment_path
            ? [{
                id: LEGACY_ATTACHMENT_ID,
                file_name: order.attachment_name,
                mime: order.attachment_mime,
                size: order.attachment_size,
                uploaded_at: order.attachment_uploaded_at,
              }]
            : [],
        });
      }
      const { data } = await admin
        .from('payment_order_attachments')
        .select('id, file_name, mime, size, uploaded_at')
        .eq('payment_order_id', order.id)
        .order('sort_order', { ascending: true })
        .order('uploaded_at', { ascending: true });
      return NextResponse.json({ success: true, attachments: data ?? [] });
    }

    // Anti-IDOR: el respaldo se busca DENTRO de los de esta orden, y la orden
    // ya se filtró por company_id. Un attachment_id de otro tenant no matchea.
    const target =
      attachmentId === LEGACY_ATTACHMENT_ID
        ? (order.attachment_path
            ? { storage_path: order.attachment_path, file_name: order.attachment_name }
            : null)
        : (rows.find((a) => a.id === attachmentId) ?? null);

    if (!target) {
      return NextResponse.json(
        { success: false, error: 'Documento de respaldo no encontrado' },
        { status: 404 },
      );
    }

    // ?download=1 → la URL firmada viene con Content-Disposition: attachment y
    // el nombre original. Sin esto, un <a download> no sirve: el redirect es
    // cross-origin (dominio de Storage) y el browser ignora el atributo.
    const wantsDownload = request.nextUrl.searchParams.get('download') === '1';
    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(
        target.storage_path,
        SIGNED_TTL_SECONDS,
        wantsDownload ? { download: target.file_name || 'documento' } : undefined,
      );

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

// ── DELETE — quitar UN documento de respaldo ────────────────────────────────

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
    if (!order) return notFound();
    if (order.status === 'cancelled') {
      return NextResponse.json(
        { success: false, error: 'Una orden anulada no admite cambios en el documento de respaldo.' },
        { status: 400 },
      );
    }

    // Con hasta MAX_PAYMENT_ATTACHMENTS archivos, "borrá el respaldo" dejó de
    // ser una orden bien definida: hay que decir cuál.
    const attachmentId = request.nextUrl.searchParams.get('attachment_id');
    if (!attachmentId) {
      return NextResponse.json(
        { success: false, error: 'Falta indicar qué documento borrar (attachment_id).' },
        { status: 400 },
      );
    }

    let removedPath: string | null = null;
    let removedName: string | null = null;

    if (attachmentId === LEGACY_ATTACHMENT_ID) {
      // Adjunto legado: no hay fila que borrar, se limpian las cinco columnas.
      if (!order.attachment_path) {
        return NextResponse.json(
          { success: false, error: 'Documento de respaldo no encontrado' },
          { status: 404 },
        );
      }
      const { error: clearError } = await admin
        .from('payment_orders')
        .update({
          attachment_path: null,
          attachment_name: null,
          attachment_mime: null,
          attachment_size: null,
          attachment_uploaded_at: null,
        })
        .eq('id', order.id)
        .eq('company_id', companyId);
      if (clearError) {
        return apiError('admin/payment-orders/attachment:clear', clearError, {
          status: 500,
          clientMessage: 'No se pudo quitar el documento de respaldo',
        });
      }
      removedPath = order.attachment_path;
      removedName = order.attachment_name;
    } else {
      const rows = await loadAttachmentRows(admin, order.id);
      const target = rows.find((a) => a.id === attachmentId);
      if (!target) {
        return NextResponse.json(
          { success: false, error: 'Documento de respaldo no encontrado' },
          { status: 404 },
        );
      }
      const { error: deleteError } = await admin
        .from('payment_order_attachments')
        .delete()
        .eq('id', target.id)
        .eq('payment_order_id', order.id)
        .eq('company_id', companyId);
      if (deleteError) {
        return apiError('admin/payment-orders/attachment:delete', deleteError, {
          status: 500,
          clientMessage: 'No se pudo quitar el documento de respaldo',
        });
      }
      removedPath = target.storage_path;
      removedName = target.file_name;

      // Si la fila borrada apuntaba al MISMO objeto que las columnas legadas
      // (caso típico: la fila la creó el backfill), esas columnas quedarían
      // señalando un archivo que ya no existe y el fallback lo resucitaría en
      // la lista. Se limpian junto con la fila.
      if (order.attachment_path && order.attachment_path === target.storage_path) {
        await admin
          .from('payment_orders')
          .update({
            attachment_path: null,
            attachment_name: null,
            attachment_mime: null,
            attachment_size: null,
            attachment_uploaded_at: null,
          })
          .eq('id', order.id)
          .eq('company_id', companyId);
      }
    }

    // Nada lo referencia ya; el archivo se borra best effort.
    await removeStored(admin, [removedPath]);

    const result = await orderResponse(admin, order.id, companyId);
    if (!result) return notFound();

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: documento de respaldo eliminado${removedName ? ` (${removedName})` : ''}`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/attachment:DELETE', err, { status: 500 });
  }
}
