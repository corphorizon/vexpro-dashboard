import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { ORDER_COLUMNS, actorName, normalizeOrder, withProofs } from '@/lib/payment-orders/server';
import { proofCountError } from '@/lib/payment-orders/types';
import {
  ALLOWED_PROOF_EXTENSIONS,
  MAX_PROOF_SIZE,
  hasAllowedProofExtension,
  sniffProof,
} from '@/lib/payment-orders/proof-files';

// ---------------------------------------------------------------------------
// /api/admin/payment-orders/[id]/proof — comprobantes de pago (OPCIONALES).
//
// Metadato operativo, no contenido económico: la orden ya lleva la referencia
// (txid / referencia bancaria) como dato obligatorio del pago; el comprobante
// es la captura o el PDF del banco que lo respalda. Por eso:
//   · Nunca es obligatorio: marcar pagada NUNCA depende de que suba el archivo.
//   · Se puede agregar o quitar incluso con la orden ya pagada — corregir un
//     comprobante mal subido no toca el contenido inmutable. El trigger
//     payment_orders_guard congela total/subtotal/fees/lines/currency/
//     beneficiario/medio de pago/wallet/cuenta/order_number; los comprobantes
//     viven en OTRA tabla (payment_order_proofs), así que ni la rozan.
//   · Solo se bloquea sobre órdenes anuladas (documento cerrado).
//
// HASTA MAX_PAYMENT_PROOFS ARCHIVOS (pedido de Kevin, migración 086)
// Antes había un solo comprobante en cinco columnas de payment_orders y el POST
// REEMPLAZABA al anterior. Ahora cada archivo es una fila de
// payment_order_proofs y el POST AGREGA. Las columnas viejas quedan como legado
// (ver la migración): si la orden tiene filas en la tabla, esas mandan.
//
// SEGURIDAD (mismo patrón que contratos de RRHH, S2): bucket PRIVADO, en la DB
// se guarda el PATH (nunca una URL pública permanente) y la lectura pasa por el
// GET de esta ruta, que valida sesión + empresa y emite una URL FIRMADA corta.
// El path nunca sale al cliente: la UI maneja `proof_id`.
//
// CONTRATO
//   POST   body multipart con uno o varios campos 'file'
//          → 200 { success, order }  — la orden CON `order.proofs` actualizado
//          → 400 si el total (existentes + nuevos) supera MAX_PAYMENT_PROOFS,
//            si algún archivo no pasa el sniff o pesa más de 10 MB, o si la
//            orden está anulada
//   GET    sin query   → 200 { success, proofs: [{id, file_name, mime, size,
//                             uploaded_at}] }
//          ?proof_id=X → 302 a una URL firmada de 10 minutos de ESE archivo
//          ?proof_id=X&download=1 → idem, pero la URL fuerza la descarga
//   DELETE ?proof_id=X → 200 { success, order } (fila + objeto del bucket)
//          → 400 sin proof_id (borrar "el comprobante" ya no es una operación
//            bien definida cuando puede haber cinco)
// ---------------------------------------------------------------------------

const BUCKET = 'payment-proofs';
/** Vida de la URL firmada: alcanza para abrir/descargar, corta para compartir. */
const SIGNED_TTL_SECONDS = 600;

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
}

interface ProofRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  sort_order: number;
}

/** Lee la orden con scope de empresa (anti-IDOR: el admin client bypassa RLS). */
async function loadOrder(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  companyId: string,
): Promise<OrderRow | null> {
  const { data } = await admin
    .from('payment_orders')
    .select('id, order_number, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  return (data as OrderRow | null) ?? null;
}

/** Comprobantes ya guardados, en orden. Incluye el storage_path: server-only. */
async function loadProofRows(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string,
): Promise<ProofRow[]> {
  const { data } = await admin
    .from('payment_order_proofs')
    .select('id, storage_path, file_name, sort_order')
    .eq('payment_order_id', orderId)
    .order('sort_order', { ascending: true })
    .order('uploaded_at', { ascending: true });
  return (data ?? []) as ProofRow[];
}

/** Borra objetos del bucket. Best effort: nunca rompe el request. */
async function removeStored(
  admin: ReturnType<typeof createAdminClient>,
  paths: string[],
): Promise<void> {
  const list = paths.filter(Boolean);
  if (list.length === 0) return;
  try {
    const { error } = await admin.storage.from(BUCKET).remove(list);
    if (error) console.error('[payment-orders/proof] borrado en storage:', error.message);
  } catch (err) {
    console.error('[payment-orders/proof] borrado en storage:', err);
  }
}

/** Respuesta estándar de POST/DELETE: la orden completa CON `proofs`. */
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
  return withProofs(admin, normalizeOrder(data as Record<string, unknown>));
}

// ── POST — agregar uno o varios comprobantes ────────────────────────────────

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
    // getAll: el cliente puede mandar 'file' una o varias veces en el mismo
    // multipart. Un solo archivo sigue funcionando igual que antes.
    const files = formData
      .getAll('file')
      .filter((f): f is File => f instanceof File && f.size > 0);

    // El tope se valida ANTES de tocar el bucket: subir cinco archivos para
    // después rechazarlos deja basura y quema ancho de banda del usuario.
    const existing = await loadProofRows(admin, order.id);
    const countError = proofCountError(existing.length, files.length);
    if (countError) {
      return NextResponse.json({ success: false, error: countError }, { status: 400 });
    }

    // Validación de TODOS los archivos antes de subir NINGUNO: un lote se
    // acepta entero o se rechaza entero (si no, el usuario queda con dos de
    // tres subidos y un error genérico).
    const prepared: { buf: Buffer; ext: string; mime: string; name: string; size: number }[] = [];
    for (const file of files) {
      if (file.size > MAX_PROOF_SIZE) {
        return NextResponse.json(
          { success: false, error: `Archivo demasiado grande (máx 10 MB): ${file.name}` },
          { status: 400 },
        );
      }
      // Primera pasada barata por extensión…
      if (!hasAllowedProofExtension(file.name)) {
        return NextResponse.json(
          {
            success: false,
            error: `Tipo de archivo no permitido (${file.name}). Solo: ${ALLOWED_PROOF_EXTENSIONS.join(', ')}`,
          },
          { status: 400 },
        );
      }
      // …y el control que manda: los bytes reales.
      const buf = Buffer.from(await file.arrayBuffer());
      const sniffed = sniffProof(buf);
      if (!sniffed) {
        return NextResponse.json(
          {
            success: false,
            error: `El archivo no es un comprobante válido (PDF, PNG, JPG o WEBP): ${file.name}`,
          },
          { status: 400 },
        );
      }
      prepared.push({
        buf,
        ext: sniffed.ext,
        mime: sniffed.mime,
        name: file.name.slice(0, 200),
        size: file.size,
      });
    }

    // sort_order continúa la numeración existente para que el nuevo archivo
    // quede al final de la lista y no reordene lo que el usuario ya vio.
    let nextSort = existing.reduce((max, p) => Math.max(max, Number(p.sort_order) || 0), -1) + 1;
    const uploadedPaths: string[] = [];
    const rows: Record<string, unknown>[] = [];

    for (const p of prepared) {
      // Path con la empresa adelante: cada tenant queda en su propio prefijo.
      // La extensión sale del sniff, no del nombre subido. El sufijo aleatorio
      // evita colisiones cuando entran dos archivos en el mismo milisegundo.
      const path = `${companyId}/${order.id}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${p.ext}`;
      const { error: uploadError } = await admin.storage
        .from(BUCKET)
        .upload(path, p.buf, { contentType: p.mime, upsert: false });

      if (uploadError) {
        // Lote atómico: lo ya subido se limpia antes de contestar el error.
        await removeStored(admin, uploadedPaths);
        return apiError('admin/payment-orders/proof:upload', uploadError, {
          status: 400,
          clientMessage: `No se pudo subir el comprobante ${p.name}`,
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

    const { error: insertError } = await admin.from('payment_order_proofs').insert(rows);
    if (insertError) {
      // Ninguna fila apunta a los archivos → no dejar huérfanos en storage.
      await removeStored(admin, uploadedPaths);
      return apiError('admin/payment-orders/proof:insert', insertError, {
        status: 500,
        clientMessage: 'No se pudieron guardar los comprobantes en la orden',
      });
    }

    const result = await orderResponse(admin, order.id, companyId);
    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details:
        `Orden ${result.order_number}: ${rows.length} comprobante${rows.length === 1 ? '' : 's'} de pago adjuntado${rows.length === 1 ? '' : 's'} ` +
        `(${prepared.map((p) => p.name).join(', ')})`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/proof:POST', err, { status: 500 });
  }
}

// ── GET — lista de comprobantes, o redirect 302 a una URL firmada ───────────

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
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    const proofId = request.nextUrl.searchParams.get('proof_id');
    const proofs = await loadProofRows(admin, order.id);

    // Sin proof_id: la lista (sin storage_path — el path no sale al cliente).
    if (!proofId) {
      const { data } = await admin
        .from('payment_order_proofs')
        .select('id, file_name, mime, size, uploaded_at')
        .eq('payment_order_id', order.id)
        .order('sort_order', { ascending: true })
        .order('uploaded_at', { ascending: true });
      return NextResponse.json({ success: true, proofs: data ?? [] });
    }

    // Anti-IDOR: el comprobante se busca DENTRO de los de esta orden, y la
    // orden ya se filtró por company_id. Un proof_id de otro tenant no matchea.
    const target = proofs.find((p) => p.id === proofId);
    if (!target) {
      return NextResponse.json(
        { success: false, error: 'Comprobante no encontrado' },
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
        wantsDownload ? { download: target.file_name || 'comprobante' } : undefined,
      );

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

// ── DELETE — quitar UN comprobante ─────────────────────────────────────────

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

    // Con hasta MAX_PAYMENT_PROOFS archivos, "borrá el comprobante" dejó de ser
    // una orden bien definida: hay que decir cuál.
    const proofId = request.nextUrl.searchParams.get('proof_id');
    if (!proofId) {
      return NextResponse.json(
        { success: false, error: 'Falta indicar qué comprobante borrar (proof_id).' },
        { status: 400 },
      );
    }

    const proofs = await loadProofRows(admin, order.id);
    const target = proofs.find((p) => p.id === proofId);
    if (!target) {
      return NextResponse.json(
        { success: false, error: 'Comprobante no encontrado' },
        { status: 404 },
      );
    }

    const { error: deleteError } = await admin
      .from('payment_order_proofs')
      .delete()
      .eq('id', target.id)
      .eq('payment_order_id', order.id)
      .eq('company_id', companyId);

    if (deleteError) {
      return apiError('admin/payment-orders/proof:delete', deleteError, {
        status: 500,
        clientMessage: 'No se pudo quitar el comprobante',
      });
    }

    // La fila ya no lo referencia; el archivo se borra best effort.
    await removeStored(admin, [target.storage_path]);

    const result = await orderResponse(admin, order.id, companyId);
    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Orden ${result.order_number}: comprobante de pago eliminado${target.file_name ? ` (${target.file_name})` : ''}`,
    });

    return NextResponse.json({ success: true, order: result });
  } catch (err) {
    return apiError('admin/payment-orders/proof:DELETE', err, { status: 500 });
  }
}
