// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones de las órdenes de pago (QW11, auditoría 2026-08-06).
//
// Antes había que ENTRAR a mirar la lista: nadie se enteraba de que tenía una
// orden esperando aprobación ni de que la suya fue aprobada o rechazada.
//
// Reglas:
//   · draft → pending    ⇒ email a los ADMINS de la empresa ("hay una orden
//     esperando aprobación"), menos al emisor si es admin.
//   · → approved/rejected ⇒ email al CREADOR de la orden.
//   · → paid              ⇒ solo bandeja: el creador se enteraba del pago
//     únicamente si volvía a abrir la orden.
//
// SIEMPRE fire-and-forget: un fallo de SendGrid jamás puede bloquear una
// transición de tesorería. El idioma sale de preferred_language del
// destinatario (patrón de fase 7); default inglés como en el resto.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { notify } from '@/lib/notifications/notify';
import type { PaymentOrder, PaymentOrderStatus } from './types';

const T = {
  es: {
    pendingSubject: (n: string) => `Orden ${n} esperando aprobación`,
    pendingBody: (n: string, who: string, total: string, ben: string) =>
      `<p><strong>${who}</strong> emitió la orden de pago <strong>${n}</strong> por <strong>${total}</strong> a favor de <strong>${ben}</strong> y está esperando aprobación.</p>`,
    approvedSubject: (n: string) => `Tu orden ${n} fue aprobada`,
    approvedBody: (n: string, who: string) =>
      `<p>Tu orden de pago <strong>${n}</strong> fue <strong>aprobada</strong> por ${who}. Ya puede marcarse como pagada.</p>`,
    rejectedSubject: (n: string) => `Tu orden ${n} fue rechazada`,
    rejectedBody: (n: string, who: string, reason: string) =>
      `<p>Tu orden de pago <strong>${n}</strong> fue <strong>rechazada</strong> por ${who}.</p><p>Motivo: ${reason}</p>`,
    cta: 'Ver la orden',
  },
  en: {
    pendingSubject: (n: string) => `Payment order ${n} awaiting approval`,
    pendingBody: (n: string, who: string, total: string, ben: string) =>
      `<p><strong>${who}</strong> submitted payment order <strong>${n}</strong> for <strong>${total}</strong> payable to <strong>${ben}</strong>; it is awaiting approval.</p>`,
    approvedSubject: (n: string) => `Your order ${n} was approved`,
    approvedBody: (n: string, who: string) =>
      `<p>Your payment order <strong>${n}</strong> was <strong>approved</strong> by ${who}. It can now be marked as paid.</p>`,
    rejectedSubject: (n: string) => `Your order ${n} was rejected`,
    rejectedBody: (n: string, who: string, reason: string) =>
      `<p>Your payment order <strong>${n}</strong> was <strong>rejected</strong> by ${who}.</p><p>Reason: ${reason}</p>`,
    cta: 'View order',
  },
} as const;

const DASHBOARD_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://dashboard.horizonconsulting.ai';

function wrap(body: string, orderId: string, cta: string): string {
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#0F172A;max-width:520px;">
      ${body}
      <p style="margin-top:16px;">
        <a href="${DASHBOARD_URL}/ordenes-pago/${orderId}"
           style="display:inline-block;padding:10px 18px;background:#1E3A5F;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
          ${cta}
        </a>
      </p>
    </div>`;
}

const money = (n: number, currency: string) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/**
 * `created_by` apunta a auth.users (FK de la migración 054), pero la pantalla
 * de detalle lo compara TAMBIÉN contra company_users.id, así que hay órdenes
 * guardadas con el id de membresía. La bandeja se indexa por auth.users: ante
 * la duda se devuelve null y no se emite nada — avisarle al usuario equivocado
 * es peor que no avisar.
 */
async function resolveCreatorAuthId(
  admin: SupabaseClient,
  companyId: string,
  createdBy: string | null,
): Promise<string | null> {
  if (!createdBy) return null;

  const { data: byAuth } = await admin
    .from('company_users')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', createdBy)
    .maybeSingle();
  if (byAuth?.user_id) return byAuth.user_id as string;

  const { data: byMembership } = await admin
    .from('company_users')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('id', createdBy)
    .maybeSingle();
  if (byMembership?.user_id) return byMembership.user_id as string;

  // Un superadmin de plataforma no tiene fila en company_users, y desde el
  // 2026-08-08 crea órdenes en cualquier empresa: sin esta rama se quedaría
  // sin los avisos de su propia orden.
  const { data: byPlatform } = await admin
    .from('platform_users')
    .select('user_id')
    .eq('user_id', createdBy)
    .maybeSingle();
  return (byPlatform?.user_id as string | null) ?? null;
}

/**
 * Dispara las notificaciones de una transición. NUNCA lanza: cualquier error
 * se loguea y la transición sigue su curso.
 */
export async function notifyOrderTransition(
  admin: SupabaseClient,
  companyId: string,
  order: PaymentOrder,
  to: PaymentOrderStatus,
  actorName: string,
): Promise<void> {
  try {
    if (to !== 'pending' && to !== 'approved' && to !== 'rejected' && to !== 'paid') return;

    // Una sola resolución del creador para los dos canales: el mail y la
    // bandeja tienen que hablarle al mismo usuario.
    const creatorId = await resolveCreatorAuthId(admin, companyId, order.created_by);
    const link = `/ordenes-pago/${order.id}`;

    if (to === 'pending') {
      await notify(admin, {
        companyId,
        type: 'order.pending',
        params: {
          number: order.order_number,
          amount: money(order.total, order.currency),
          beneficiary: order.beneficiary_name,
        },
        link,
        excludeUserIds: creatorId ? [creatorId] : [],
      });
    } else if (creatorId) {
      const type = to === 'approved' ? 'order.approved' : to === 'rejected' ? 'order.rejected' : 'order.paid';
      const params =
        to === 'approved' ? { number: order.order_number, actor: actorName }
        : to === 'rejected' ? { number: order.order_number, reason: order.rejection_reason ?? '—' }
        : { number: order.order_number, reference: order.payment_reference ?? '—' };
      await notify(admin, { companyId, type, params, link, targetUserIds: [creatorId] });
    }

    // El pago solo va a la bandeja: no hay plantilla de email para "pagada".
    if (to === 'paid') return;

    // Import dinámico: emailService arrastra sgMail y estas rutas no lo
    // necesitan en el camino caliente (mismo criterio que invite-user).
    const { sendEmail } = await import('@/services/emailService');

    type Recipient = { email: string; name: string; preferred_language?: string | null; user_id: string };

    if (to === 'pending') {
      const { data } = await admin
        .from('company_users')
        .select('email, name, preferred_language, user_id')
        .eq('company_id', companyId)
        .eq('role', 'admin')
        .eq('status', 'active');
      const admins = ((data ?? []) as Recipient[])
        // El emisor no necesita enterarse de su propia orden.
        .filter((a) => a.user_id !== creatorId);

      await Promise.allSettled(admins.map((a) => {
        const L = T[a.preferred_language === 'es' ? 'es' : 'en'];
        return sendEmail(
          a.email,
          L.pendingSubject(order.order_number),
          wrap(
            L.pendingBody(order.order_number, actorName, money(order.total, order.currency), order.beneficiary_name),
            order.id, L.cta,
          ),
          undefined, companyId,
        );
      }));
      return;
    }

    // approved / rejected → al creador.
    if (!creatorId) return;
    const { data: creator } = await admin
      .from('company_users')
      .select('email, name, preferred_language, user_id')
      .eq('company_id', companyId)
      .eq('user_id', creatorId)
      .maybeSingle();
    if (!creator?.email) return;

    const L = T[(creator as Recipient).preferred_language === 'es' ? 'es' : 'en'];
    const subject = to === 'approved'
      ? L.approvedSubject(order.order_number)
      : L.rejectedSubject(order.order_number);
    const body = to === 'approved'
      ? L.approvedBody(order.order_number, actorName)
      : L.rejectedBody(order.order_number, actorName, order.rejection_reason ?? '—');

    await sendEmail(creator.email, subject, wrap(body, order.id, L.cta), undefined, companyId);
  } catch (err) {
    // Best effort: la tesorería no depende del correo.
    console.error('[payment-orders/notifications]', err instanceof Error ? err.message : err);
  }
}
