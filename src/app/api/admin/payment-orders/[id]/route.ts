import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { PAYMENT_ORDER_READ_ROLES, PAYMENT_ORDER_PREPARE_ROLES } from '@/lib/roles';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import {
  isEditable,
  PAYMENT_ATTACHMENTS_BUCKET,
  PAYMENT_PROOFS_BUCKET,
  STATUS_LABELS,
  type PaymentOrderStatus,
} from '@/lib/payment-orders/types';
import {
  deleteAuditDetails,
  orderStoragePaths,
  splitStillReferenced,
  storageRemovalOutcome,
  type DeletedExpenseSummary,
  type DeletedOrderSummary,
} from '@/lib/payment-orders/delete';
import {
  ORDER_COLUMNS,
  actorName,
  beneficiaryPayloadFromOrder,
  normalizeOrder,
  orderFieldsFromInput,
  beneficiaryBelongsToCompany,
  upsertBeneficiary,
  validateOrderInput,
  withFiles,
} from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// GET    /api/admin/payment-orders/[id]  → una orden
// PATCH  /api/admin/payment-orders/[id]  → editar (SOLO draft / rejected)
// DELETE /api/admin/payment-orders/[id]  → borrado DEFINITIVO (cualquier estado)
//
// Toda query por id filtra además por company_id: el admin client bypassa RLS,
// así que sin ese filtro un admin de la empresa A podría leer/editar/borrar
// órdenes de la empresa B pasando su UUID.
//
// ── DELETE: de "solo borradores" a "cualquier estado" (2026-10-01) ─────────
// Hasta acá solo se borraba un borrador; lo emitido se ANULABA (transición →
// cancelled), que deja la fila. El dueño pidió poder eliminar una orden "si se
// debe" Y que se vaya también de Egresos, porque una orden PAGADA genera un
// egreso (expenses.payment_order_id) que la anulación no toca. Anular sigue
// existiendo y sigue siendo lo normal; eliminar es la salida para la orden que
// no debió existir (duplicada, cargada en la empresa equivocada…).
//
// ORDEN DE LOS PASOS (y por qué no es el obvio):
//   0. INVENTARIO antes de tocar nada: egreso(s), período(s) del egreso,
//      archivos de las dos tablas hijas + columnas legadas, y si algún OTRO
//      egreso referencia los mismos comprobantes. Si algo de esto no se puede
//      leer, se aborta: borrar a ciegas es borrar sin poder contar.
//   1. EL EGRESO PRIMERO. La FK expenses.payment_order_id es ON DELETE SET
//      NULL (migración 058): si se borrara la orden antes, el egreso quedaría
//      con payment_order_id = NULL — o sea MANUAL a ojos de
//      replace_period_expenses — y la plata seguiría contando en el mes sin
//      orden detrás. Es el vínculo OP↔egreso que ya se rompió una vez
//      (reglas §2.4, migración 079). Si el egreso está en un período CERRADO,
//      el trigger guard_closed_period (061) lo rechaza (sin bypass para
//      service_role): se devuelve 409 ANTES de tocar nada más.
//   2. LA ORDEN. Las filas de payment_order_proofs (086) y
//      payment_order_attachments (127) se van por ON DELETE CASCADE; se
//      contaron en el paso 0, así que el desglose las informa igual. El DELETE
//      lleva además `.eq('status', <el leído>)`: si alguien la marcó pagada
//      entre el inventario y acá (y nació un egreso que no inventariamos), no
//      se borra nada y se pide reintentar — sin ese candado el egreso nuevo
//      quedaría huérfano por el SET NULL de arriba.
//   3. STORAGE AL FINAL, best-effort. Se descartó el orden "archivos antes que
//      la orden": si la orden después no se borraba, quedaba viva apuntando a
//      archivos que ya no existen (rota y sin error). Al revés, lo peor es un
//      objeto huérfano en un bucket privado: basura, no un número falso. Lo
//      que no se pudo borrar se CUENTA y se loguea, nunca aborta.
//
// ¿PUEDE RESUCITAR EL EGRESO DESDE UNA PANTALLA ABIERTA? (la trampa §2.4)
// Escenario: alguien tiene /upload abierto desde antes, con la fila del egreso
// de esta OP en su estado, y guarda el mes después de que acá se borró. La RPC
// replace_period_expenses re-inserta el período desde ese payload VIEJO.
// Respuesta: NO resucita, por la migración 079 — la RPC filtra
// `payment_order_id IS NULL` en el DELETE **y en el INSERT**, así que una fila
// de OP que venga en el payload se ignora, venga de donde venga. Y no hay
// camino en /upload que le quite el payment_order_id a una fila existente
// (solo nacen con null las filas manuales, de plantilla o de import). Lo único
// que queda es cosmético: esa pestaña sigue MOSTRANDO la fila hasta recargar.
// Esto depende de que la 079 esté aplicada en la base (lo está desde agosto
// 2026, es el fix de los $1.700); si alguien la revirtiera, esta garantía cae.
// ---------------------------------------------------------------------------

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const auth = await verifyAdminAuth(request, { roles: PAYMENT_ORDER_READ_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('payment_orders')
      .select(ORDER_COLUMNS)
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (error) return apiError('admin/payment-orders/[id] GET', error, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    // Con `proofs` y `attachments`: el detalle es la pantalla que lista los
    // dos juegos de archivos (migraciones 086 y 127).
    return NextResponse.json({
      success: true,
      order: await withFiles(admin, normalizeOrder(data as Record<string, unknown>)),
    });
  } catch (err) {
    return apiError('admin/payment-orders/[id] GET', err, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const auth = await verifyAdminAuth(request, { roles: PAYMENT_ORDER_PREPARE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const companyId = auth.companyId;

    const { data: current } = await admin
      .from('payment_orders')
      .select('id, status, order_number, beneficiary_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    const status = current.status as PaymentOrderStatus;
    if (!isEditable(status)) {
      return NextResponse.json(
        {
          success: false,
          error: `Una orden en estado "${STATUS_LABELS.es[status]}" no se puede editar. Anulala y emití una nueva.`,
        },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => null);
    const validated = validateOrderInput(body);
    if ('error' in validated) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    // El beneficiario referenciado tiene que ser de ESTA empresa: el admin
    // client no pasa por RLS, así que sin este chequeo un id ajeno vinculaba
    // la orden al beneficiario de otro tenant (auditoría 2026-08-06).
    if (!(await beneficiaryBelongsToCompany(admin, auth.companyId, validated.input.beneficiary_id))) {
      return NextResponse.json(
        { success: false, error: 'Beneficiario no encontrado' },
        { status: 404 },
      );
    }

    // Solo campos del payload: status, order_number, company_id y el bloque de
    // auditoría no se tocan desde acá (para eso está /transition).
    const { data, error } = await admin
      .from('payment_orders')
      .update({ ...orderFieldsFromInput(validated), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (error) return apiError('admin/payment-orders/[id] PATCH', error, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'No se actualizó ninguna fila' },
        { status: 404 },
      );
    }

    const order = normalizeOrder(data as Record<string, unknown>);

    if (validated.input.save_beneficiary) {
      const beneficiary = await upsertBeneficiary(
        admin,
        companyId,
        beneficiaryPayloadFromOrder(validated),
      );
      if (beneficiary && !order.beneficiary_id) {
        await admin
          .from('payment_orders')
          .update({ beneficiary_id: beneficiary.id })
          .eq('id', order.id)
          .eq('company_id', companyId);
        order.beneficiary_id = beneficiary.id;
      }
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Editó la orden de pago ${order.order_number} — ${order.beneficiary_name} — ${order.currency} ${order.total}`,
    });

    // Mismo shape que el GET: la orden viaja siempre con `proofs` y `attachments`.
    return NextResponse.json({ success: true, order: await withFiles(admin, order) });
  } catch (err) {
    return apiError('admin/payment-orders/[id] PATCH', err, { status: 500 });
  }
}

// ── DELETE — borrado definitivo (ver cabecera: orden de los pasos) ─────────

interface OrderToDelete {
  id: string;
  status: PaymentOrderStatus;
  order_number: string;
  beneficiary_name: string;
  total: number | string;
  currency: string;
  expense_id: string | null;
  payment_proof_path: string | null;
  attachment_path: string | null;
}

interface ExpenseRow {
  id: string;
  amount: number | string;
  concept: string | null;
  period_id: string | null;
  payment_order_id: string | null;
}

/**
 * ¿El error es "la tabla no existe"? Solo se tolera para
 * payment_order_attachments: el código de la 127 se despliega antes de que la
 * migración se aplique a mano (ver loadOrderAttachments en server.ts). En esa
 * ventana el respaldo vive en las columnas legadas, que ya se inventarían.
 */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === '42P01' ||
    err.code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(err.message ?? '')
  );
}

/** El trigger guard_closed_period (061) levanta check_violation (23514). */
function isClosedPeriodError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '23514' || /periodo.*cerrado/i.test(err.message ?? '');
}

const n2 = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    // Mismo gate que toda escritura del módulo (FINANCE_ROLES = admin/auditor
    // + el módulo payment_orders). Es el más restrictivo que existe acá:
    // 'hr' solo LEE órdenes (PAYMENT_ORDER_READ_ROLES) y no llega a esta línea.
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const companyId = auth.companyId;
    const who = actorName(auth);

    const { data: currentRaw, error: readErr } = await admin
      .from('payment_orders')
      .select(
        'id, status, order_number, beneficiary_name, total, currency, expense_id, payment_proof_path, attachment_path',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (readErr) return apiError('admin/payment-orders/[id] DELETE:read', readErr, { status: 500 });
    if (!currentRaw) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }
    const current = currentRaw as OrderToDelete;
    const statusLabel = STATUS_LABELS.es[current.status] ?? current.status;

    // ── 0. INVENTARIO — nada se toca hasta saber todo lo que se va ──────────

    // 0a. Egreso(s) vinculados: por el vínculo directo (único desde la 079)…
    const EXPENSE_COLS = 'id, amount, concept, period_id, payment_order_id';
    const { data: byLink, error: linkErr } = await admin
      .from('expenses')
      .select(EXPENSE_COLS)
      .eq('company_id', companyId)
      .eq('payment_order_id', id);
    if (linkErr) {
      return apiError('admin/payment-orders/[id] DELETE:expenses', linkErr, {
        status: 500,
        clientMessage: 'No se pudo verificar el egreso vinculado. No se borró nada.',
      });
    }
    const expenses = [...((byLink ?? []) as ExpenseRow[])];

    // …y por el puntero inverso, para órdenes previas a la 058 cuyo egreso
    // nunca tuvo payment_order_id. Solo si esa fila no es de OTRA orden.
    if (current.expense_id && !expenses.some((e) => e.id === current.expense_id)) {
      const { data: byPtr, error: ptrErr } = await admin
        .from('expenses')
        .select(EXPENSE_COLS)
        .eq('company_id', companyId)
        .eq('id', current.expense_id)
        .maybeSingle();
      if (ptrErr) {
        return apiError('admin/payment-orders/[id] DELETE:expense-ptr', ptrErr, {
          status: 500,
          clientMessage: 'No se pudo verificar el egreso vinculado. No se borró nada.',
        });
      }
      const row = byPtr as ExpenseRow | null;
      if (row && (row.payment_order_id === null || row.payment_order_id === id)) {
        expenses.push(row);
      }
    }

    // 0b. ¿Algún egreso cae en un período CERRADO? El trigger lo rechazaría
    // igual; preguntarlo antes permite decir CUÁL mes reabrir.
    const periodIds = Array.from(
      new Set(expenses.map((e) => e.period_id).filter((p): p is string => !!p)),
    );
    if (periodIds.length > 0) {
      const { data: periods, error: perErr } = await admin
        .from('periods')
        .select('id, year, month, label, is_closed')
        .eq('company_id', companyId)
        .in('id', periodIds);
      if (perErr) {
        return apiError('admin/payment-orders/[id] DELETE:periods', perErr, {
          status: 500,
          clientMessage: 'No se pudo verificar el período del egreso vinculado. No se borró nada.',
        });
      }
      const closed = ((periods ?? []) as {
        year: number; month: number; label: string | null; is_closed: boolean;
      }[]).filter((p) => p.is_closed);
      if (closed.length > 0) {
        const labels = closed
          .map((p) => p.label || `${p.year}-${String(p.month).padStart(2, '0')}`)
          .join(', ');
        return NextResponse.json(
          {
            success: false,
            error:
              `El egreso de la orden ${current.order_number} está en un período CERRADO (${labels}). ` +
              'Reabrí el período (con motivo) para poder eliminarla. No se borró nada.',
          },
          { status: 409 },
        );
      }
    }

    // 0c. Archivos: comprobantes (086), respaldos (127) y columnas legadas.
    const { data: proofRows, error: proofErr } = await admin
      .from('payment_order_proofs')
      .select('storage_path')
      .eq('payment_order_id', id)
      .eq('company_id', companyId);
    if (proofErr) {
      return apiError('admin/payment-orders/[id] DELETE:proofs', proofErr, {
        status: 500,
        clientMessage: 'No se pudieron inventariar los comprobantes de la orden. No se borró nada.',
      });
    }
    const { data: attRows, error: attErr } = await admin
      .from('payment_order_attachments')
      .select('storage_path')
      .eq('payment_order_id', id)
      .eq('company_id', companyId);
    if (attErr && !isMissingTable(attErr)) {
      return apiError('admin/payment-orders/[id] DELETE:attachments', attErr, {
        status: 500,
        clientMessage: 'No se pudieron inventariar los documentos de respaldo de la orden. No se borró nada.',
      });
    }
    const proofs = (proofRows ?? []) as { storage_path: string | null }[];
    const atts = (attErr ? [] : (attRows ?? [])) as { storage_path: string | null }[];

    const paths = orderStoragePaths({
      proofPaths: proofs.map((p) => p.storage_path),
      attachmentPaths: atts.map((a) => a.storage_path),
      legacyProofPath: current.payment_proof_path,
      legacyAttachmentPath: current.attachment_path,
    });

    // 0d. ¿Otro egreso (no los que se borran) apunta a alguno de estos
    // comprobantes? Ver splitStillReferenced. Si no se puede averiguar, NO se
    // borra ningún comprobante del bucket (se cuentan como no confirmados):
    // un huérfano es preferible a romperle el adjunto a otra fila.
    const deletingIds = new Set(expenses.map((e) => e.id));
    let proofSplit = { remove: paths.proofs, keep: [] as string[] };
    let proofsUnverified = 0;
    if (paths.proofs.length > 0) {
      const { data: refs, error: refErr } = await admin
        .from('expenses')
        .select('id, attachment_path')
        .eq('company_id', companyId)
        .in('attachment_path', paths.proofs);
      if (refErr) {
        console.error('[payment-orders DELETE] no se pudo verificar referencias a comprobantes:', refErr.message);
        proofSplit = { remove: [], keep: [] };
        proofsUnverified = paths.proofs.length;
      } else {
        const elsewhere = ((refs ?? []) as { id: string; attachment_path: string | null }[])
          .filter((r) => !deletingIds.has(r.id))
          .map((r) => r.attachment_path);
        proofSplit = splitStillReferenced(paths.proofs, elsewhere);
      }
    }

    // ── 1. EL EGRESO (antes que la orden: ver cabecera) ────────────────────
    let deletedExpenses: DeletedExpenseSummary[] = [];
    if (expenses.length > 0) {
      const { data: gone, error: expDelErr } = await admin
        .from('expenses')
        .delete()
        .eq('company_id', companyId)
        .in('id', expenses.map((e) => e.id))
        .select('id');
      if (expDelErr) {
        if (isClosedPeriodError(expDelErr)) {
          return NextResponse.json(
            {
              success: false,
              error:
                `El egreso de la orden ${current.order_number} está en un período cerrado. ` +
                'Reabrí el período (con motivo) para poder eliminarla. No se borró nada.',
            },
            { status: 409 },
          );
        }
        return apiError('admin/payment-orders/[id] DELETE:expense', expDelErr, {
          status: 500,
          clientMessage: 'No se pudo borrar el egreso vinculado. No se borró nada.',
        });
      }
      const goneIds = new Set(((gone ?? []) as { id: string }[]).map((g) => g.id));
      deletedExpenses = expenses
        .filter((e) => goneIds.has(e.id))
        .map((e) => ({
          id: e.id,
          amount: n2(e.amount),
          concept: e.concept,
          period_id: e.period_id,
        }));
    }

    // ── 2. LA ORDEN (comprobantes y respaldos se van por cascade) ──────────
    const { data: goneOrder, error: orderDelErr } = await admin
      .from('payment_orders')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', current.status)
      .select('id');

    if (orderDelErr || !goneOrder || goneOrder.length === 0) {
      const stateChanged = !orderDelErr;
      // Si el egreso ya se fue y la orden no, eso TIENE que quedar escrito: la
      // orden sigue viva sin su egreso hasta que alguien reintente.
      if (deletedExpenses.length > 0) {
        await serverAuditLog(admin, {
          companyId,
          actorId: auth.userId,
          actorName: who,
          action: 'delete',
          module: 'payment-orders',
          details:
            `Borrado INCOMPLETO de la orden ${current.order_number}: se eliminó su egreso ` +
            deletedExpenses.map((e) => `(id ${e.id}, ${current.currency} ${e.amount.toFixed(2)})`).join(', ') +
            ` pero la orden NO se borró${orderDelErr ? ` (${orderDelErr.message})` : ' (cambió de estado)'}. Reintentar la eliminación.`,
        });
      }
      const msg =
        (deletedExpenses.length > 0
          ? `Se borró el egreso vinculado pero la orden ${current.order_number} NO. `
          : `La orden ${current.order_number} no se borró. `) +
        (stateChanged
          ? 'Cambió de estado mientras se eliminaba: recargá la lista y volvé a intentarlo.'
          : 'Volvé a intentarlo; si persiste, avisá al equipo técnico.');
      if (orderDelErr) console.error('[payment-orders DELETE] orden:', orderDelErr.message);
      return NextResponse.json(
        { success: false, error: msg },
        { status: stateChanged ? 409 : 500 },
      );
    }

    // ── 3. STORAGE (best-effort: cuenta, loguea, nunca aborta) ─────────────
    async function removeFrom(bucket: string, list: string[]): Promise<{ removed: number; failed: number }> {
      if (list.length === 0) return { removed: 0, failed: 0 };
      try {
        const { data, error } = await admin.storage.from(bucket).remove(list);
        if (error) {
          console.error(`[payment-orders DELETE] storage ${bucket}:`, error.message, list);
          return storageRemovalOutcome(list.length, null);
        }
        const out = storageRemovalOutcome(list.length, (data ?? []).length);
        if (out.failed > 0) {
          console.error(`[payment-orders DELETE] storage ${bucket}: ${out.failed} objeto(s) sin confirmar`, list);
        }
        return out;
      } catch (err) {
        console.error(`[payment-orders DELETE] storage ${bucket}:`, err, list);
        return storageRemovalOutcome(list.length, null);
      }
    }

    const proofOut = await removeFrom(PAYMENT_PROOFS_BUCKET, proofSplit.remove);
    const attOut = await removeFrom(PAYMENT_ATTACHMENTS_BUCKET, paths.attachments);

    // ── 4. DESGLOSE + AUDIT ─────────────────────────────────────────────────
    const summary: DeletedOrderSummary = {
      orden: {
        id: current.id,
        order_number: current.order_number,
        beneficiary_name: current.beneficiary_name,
        total: n2(current.total),
        currency: current.currency,
        status: current.status,
      },
      egresosBorrados: deletedExpenses,
      adjuntosBorrados: { comprobantes: proofs.length, respaldos: atts.length },
      archivosBorrados: proofOut.removed + attOut.removed,
      archivosFallidos: proofOut.failed + attOut.failed + proofsUnverified,
      archivosPreservados: proofSplit.keep.length,
    };

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: who,
      action: 'delete',
      module: 'payment-orders',
      details: deleteAuditDetails(summary, statusLabel),
    });

    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    return apiError('admin/payment-orders/[id] DELETE', err, { status: 500 });
  }
}
