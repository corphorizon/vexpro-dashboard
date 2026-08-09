// ─────────────────────────────────────────────────────────────────────────────
// Emisor de notificaciones (SERVER-ONLY).
//
// Una sola puerta de entrada: `notify()`. Resuelve destinatarios, deduplica y
// escribe. Los llamadores solo dicen QUÉ pasó — nunca A QUIÉN avisar, porque
// esa regla vive en el catálogo y tiene que ser la misma en los 14 puntos de
// emisión.
//
// NUNCA TIRA. Una notificación es un efecto secundario: si falla el aviso de
// que una orden se aprobó, la orden igual se aprobó. Mismo criterio que
// payment-orders/notifications.ts con los emails.
//
// No se emite desde el cliente. src/lib/audit-log.ts ya enseñó por qué: es
// fire-and-forget desde el browser con fallback a localStorage, así que los
// eventos solo quedan si el navegador coopera. Un aviso que depende de eso no
// es un aviso.
// ─────────────────────────────────────────────────────────────────────────────

import type { createAdminClient } from '@/lib/supabase/admin';
import { FINANCE_ROLES } from '@/lib/roles';
import { notificationType, type NotificationSeverity } from './catalog';

type Admin = ReturnType<typeof createAdminClient>;

export interface NotifyInput {
  /** Empresa del evento. null solo para avisos de plataforma. */
  companyId: string | null;
  /** Clave del catálogo. Si no existe, no se emite nada (y se avisa por log). */
  type: string;
  /** Valores a interpolar en el texto i18n. Se guardan como strings. */
  params?: Record<string, string | number | null | undefined>;
  /** Adónde lleva el click. */
  link?: string | null;
  /**
   * Sin esto, un cron que corre 4 veces al día genera 4 avisos idénticos.
   * Se le antepone el tipo y se recomienda incluir el día (ver dailyKey).
   */
  dedupeKey?: string | null;
  /**
   * Para los tipos de audiencia 'user'. Son ids de auth.users — los mismos
   * que guarda company_users.user_id y platform_users.user_id.
   */
  targetUserIds?: string[];
  /** Ids de auth.users que NO deben recibirlo (típico: quien causó el evento). */
  excludeUserIds?: string[];
}

interface Recipient {
  userId: string;
  email: string | null;
  language: string | null;
}

/** Sufijo de dedupe por día: un fallo que persiste vuelve a avisar mañana. */
export function dailyKey(base: string, day: string = new Date().toISOString().slice(0, 10)): string {
  return `${base}:${day}`;
}

/**
 * Destinatarios de la empresa según la audiencia del tipo.
 *
 * `allowed_modules` decide QUÉ VE un usuario, así que un aviso de un módulo
 * que no tiene asignado sería ruido sobre una pantalla a la que ni entra.
 */
async function companyRecipients(
  admin: Admin,
  companyId: string,
  audience: 'admins' | 'finance',
  module: string | null,
): Promise<Recipient[]> {
  const { data, error } = await admin
    .from('company_users')
    .select('user_id, email, role, status, allowed_modules, preferred_language')
    .eq('company_id', companyId);
  if (error) {
    console.error('[notify] company_users:', error.message);
    return [];
  }

  const roles: readonly string[] = audience === 'admins' ? ['admin'] : FINANCE_ROLES;
  return ((data ?? []) as Array<{
    user_id: string | null; email: string | null; role: string; status: string | null;
    allowed_modules: string[] | null; preferred_language: string | null;
  }>)
    .filter((u) => {
      if (!u.user_id || u.status === 'inactive') return false;
      if (!roles.includes(u.role)) return false;
      if (module && !(Array.isArray(u.allowed_modules) && u.allowed_modules.includes(module))) {
        return false;
      }
      return true;
    })
    .map((u) => ({ userId: u.user_id as string, email: u.email, language: u.preferred_language }));
}

/**
 * Superadmins de plataforma. Van en TODA notificación de empresa: supervisan
 * el grupo entero y no tienen fila en company_users, así que ninguna consulta
 * por tenant los alcanza. Es el mismo agujero que tenían los emails de
 * reportes hasta 2026-08-08 (reports/send.ts).
 */
async function platformRecipients(admin: Admin): Promise<Recipient[]> {
  const { data, error } = await admin
    .from('platform_users')
    .select('user_id, email, preferred_language');
  if (error) {
    console.error('[notify] platform_users:', error.message);
    return [];
  }
  return ((data ?? []) as Array<{ user_id: string | null; email: string | null; preferred_language: string | null }>)
    .filter((p) => !!p.user_id)
    .map((p) => ({ userId: p.user_id as string, email: p.email, language: p.preferred_language }));
}

/** Los ids que pidió el llamador, con su email/idioma para el mail. */
async function explicitRecipients(admin: Admin, userIds: string[]): Promise<Recipient[]> {
  if (userIds.length === 0) return [];
  const [company, platform] = await Promise.all([
    admin.from('company_users').select('user_id, email, preferred_language').in('user_id', userIds),
    admin.from('platform_users').select('user_id, email, preferred_language').in('user_id', userIds),
  ]);
  const rows = [...(company.data ?? []), ...(platform.data ?? [])] as Array<{
    user_id: string; email: string | null; preferred_language: string | null;
  }>;
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  // Un id sin fila igual recibe la notificación in-app (existe en auth.users);
  // solo se queda sin email.
  return userIds.map((id) => ({
    userId: id,
    email: byId.get(id)?.email ?? null,
    language: byId.get(id)?.preferred_language ?? null,
  }));
}

export interface NotifyResult {
  created: number;
  recipients: number;
}

export async function notify(admin: Admin, input: NotifyInput): Promise<NotifyResult> {
  try {
    const def = notificationType(input.type);
    if (!def) {
      // Tipo fuera del catálogo: casi siempre un typo en el llamador.
      console.error(`[notify] tipo desconocido: ${input.type}`);
      return { created: 0, recipients: 0 };
    }

    let recipients: Recipient[];
    if (def.audience === 'user') {
      recipients = await explicitRecipients(admin, input.targetUserIds ?? []);
    } else if (input.companyId) {
      const [company, platform] = await Promise.all([
        companyRecipients(admin, input.companyId, def.audience, def.module),
        platformRecipients(admin),
      ]);
      recipients = [...company, ...platform];
    } else {
      recipients = await platformRecipients(admin);
    }

    const excluded = new Set(input.excludeUserIds ?? []);
    const seen = new Set<string>();
    const finalRecipients = recipients.filter((r) => {
      if (!r.userId || excluded.has(r.userId) || seen.has(r.userId)) return false;
      seen.add(r.userId);
      return true;
    });
    if (finalRecipients.length === 0) return { created: 0, recipients: 0 };

    // Los params van como strings: la UI solo interpola texto, y guardar
    // números sueltos invita a formatearlos distinto en cada pantalla.
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (v !== null && v !== undefined) params[k] = String(v);
    }

    const dedupe = input.dedupeKey ? `${input.type}:${input.dedupeKey}` : null;
    const rows = finalRecipients.map((r) => ({
      company_id: input.companyId,
      user_id: r.userId,
      type: def.key,
      severity: def.severity as NotificationSeverity,
      params,
      link: input.link ?? null,
      dedupe_key: dedupe,
    }));

    const { data, error } = await admin.rpc('push_notifications', { p_rows: rows });
    if (error) {
      console.error('[notify] push_notifications:', error.message);
      return { created: 0, recipients: finalRecipients.length };
    }

    return { created: Number(data) || 0, recipients: finalRecipients.length };
  } catch (err) {
    console.error('[notify] inesperado:', err instanceof Error ? err.message : err);
    return { created: 0, recipients: 0 };
  }
}
