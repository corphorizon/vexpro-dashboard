// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de tipos de notificación.
//
// Mismo criterio que src/lib/modules.ts y src/lib/roles.ts: el catálogo vive
// en UN archivo y lo importan el emisor, la bandeja, el panel de preferencias
// y los tests. Declarar un tipo en el generador y otra vez en la UI es
// exactamente cómo este repo se rompió antes (módulos que el endpoint
// descartaba en silencio, roles que el CHECK rechazaba).
//
// El TEXTO no vive acá ni en la base: cada notificación guarda su `type` más
// unos `params`, y la UI renderiza con i18n. Guardar la frase ya armada la
// congelaría en el idioma que tenía el usuario cuando se generó — y el idioma
// se cambia con un botón.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

/** Qué tan fuerte pide atención. Ordena la bandeja y decide si además va mail. */
export type NotificationSeverity = 'critical' | 'high' | 'normal';

/** A quién le importa. Se resuelve contra roles + allowed_modules. */
export type NotificationAudience =
  /** Solo admins de la empresa. */
  | 'admins'
  /** Quienes pueden operar dinero: admin + auditor. */
  | 'finance'
  /** Un usuario puntual (lo pasa el emisor). */
  | 'user';

export interface NotificationTypeDef {
  key: string;
  severity: NotificationSeverity;
  audience: NotificationAudience;
  /** Módulo que el destinatario debe tener habilitado (null = no se exige). */
  module: string | null;
  /**
   * Además de la bandeja, manda email. Se reserva para lo que no puede
   * esperar a que alguien abra el dashboard.
   */
  email: boolean;
  /**
   * Clave i18n del título y del cuerpo. El cuerpo admite {params}.
   * Convención: notif.<key>.title / notif.<key>.body
   */
  i18nKey: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// El catálogo. Primera versión: 8 avisos elegidos por Kevin sobre el
// inventario del 2026-08-09 — los procesos que fallaban en silencio, lo que
// espera una decisión humana, y el rastro de seguridad que no existía.
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES: NotificationTypeDef[] = [
  // ── Procesos automáticos que hoy fallan sin que nadie se entere ──────────
  {
    key: 'sync.failed',
    severity: 'critical', audience: 'finance', module: 'movements',
    email: false, i18nKey: 'notif.syncFailed',
  },
  {
    // El sync del CRM dejó de correr. Va con correo y como crítica porque su
    // muerte es INVISIBLE: el traspaso a Retención se dispara desde dentro de
    // ese sync, así que si deja de correr nadie pasa a Retención y no hay
    // ningún error en ningún lado — sólo un equipo que deja de recibir gente.
    key: 'crm_sync.stale',
    severity: 'critical', audience: 'admins', module: 'risk',
    email: true, i18nKey: 'notif.crmSyncStale',
  },
  {
    key: 'ledger.not_posted',
    severity: 'critical', audience: 'finance', module: 'balances',
    email: true, i18nKey: 'notif.ledgerNotPosted',
  },
  {
    // El libro venía congelado y se destrabó SOLO, asentando una línea que
    // cubre varios días (ver RECOVERY_AFTER_DAYS en channel-ledger-sync.ts).
    // Va con correo y como crítica porque el saldo del canal vuelve a ser
    // correcto —eso es lo que se buscaba— pero el DESGLOSE de esos días no
    // existe: alguien tiene que decidir si reprocesarlos uno por uno con
    // scripts/backfill-channel-ledger.ts. Sin este aviso, el canal se ve sano
    // y nadie se entera de que hay un tramo sin abrir.
    key: 'ledger.regularized',
    severity: 'critical', audience: 'finance', module: 'balances',
    email: true, i18nKey: 'notif.ledgerRegularized',
  },
  {
    key: 'period.not_created',
    severity: 'critical', audience: 'admins', module: null,
    email: true, i18nKey: 'notif.periodNotCreated',
  },

  // ── Órdenes de pago: lo que espera una decisión ──────────────────────────
  {
    key: 'order.pending',
    severity: 'high', audience: 'finance', module: 'payment_orders',
    email: false, i18nKey: 'notif.orderPending',
  },
  {
    key: 'order.approved',
    severity: 'high', audience: 'user', module: null,
    email: false, i18nKey: 'notif.orderApproved',
  },
  {
    key: 'order.rejected',
    severity: 'high', audience: 'user', module: null,
    email: false, i18nKey: 'notif.orderRejected',
  },
  {
    key: 'order.paid',
    severity: 'normal', audience: 'user', module: null,
    email: false, i18nKey: 'notif.orderPaid',
  },
  {
    key: 'order.approved_unpaid',
    severity: 'high', audience: 'finance', module: 'payment_orders',
    email: false, i18nKey: 'notif.orderApprovedUnpaid',
  },

  // ── Cierre de período ────────────────────────────────────────────────────
  {
    key: 'period.still_open',
    severity: 'high', audience: 'admins', module: null,
    email: false, i18nKey: 'notif.periodStillOpen',
  },

  // ── Retiros de prop firm: el veredicto que nadie va a ir a buscar ───────
  // La revisión automática ya corre cada 30 minutos y deja el veredicto en la
  // cola, pero el veredicto sólo existe para quien ENTRA a la pantalla. Un
  // retiro con infracciones que nadie abre se paga igual que uno limpio.
  {
    // Va con correo y como crítica porque lo que está del otro lado es un
    // pago: cuando se autoriza, el dinero salió y no hay vuelta atrás. Sólo
    // se emite cuando el veredicto NO es 'ok' — ver propfirmAlertFor().
    key: 'propfirm.review_violations',
    severity: 'critical', audience: 'admins', module: 'risk',
    email: true, i18nKey: 'notif.propfirmReviewViolations',
  },
  {
    // La revisión no se pudo hacer (faltó MT5, faltó el ciclo, reventó algo).
    // Existe como aviso propio porque el silencio acá MIENTE: una fila sin
    // veredicto se ve igual que una revisada y limpia. Sin correo y como
    // 'high' y no 'critical': es un fallo operativo nuestro, no un cliente
    // incumpliendo — se arregla en horario de oficina.
    key: 'propfirm.review_failed',
    severity: 'high', audience: 'admins', module: 'risk',
    email: false, i18nKey: 'notif.propfirmReviewFailed',
  },

  // ── Seguridad. Estas rutas no dejaban NINGÚN rastro (ni audit log) ───────
  {
    key: 'security.twofa_reset',
    severity: 'critical', audience: 'admins', module: 'users',
    email: true, i18nKey: 'notif.securityTwofaReset',
  },
  {
    key: 'security.password_reset',
    severity: 'critical', audience: 'admins', module: 'users',
    email: true, i18nKey: 'notif.securityPasswordReset',
  },
  {
    key: 'security.user_created',
    severity: 'high', audience: 'admins', module: 'users',
    email: false, i18nKey: 'notif.securityUserCreated',
  },
  {
    key: 'security.user_deleted',
    severity: 'critical', audience: 'admins', module: 'users',
    email: true, i18nKey: 'notif.securityUserDeleted',
  },
  {
    key: 'security.api_credentials',
    severity: 'critical', audience: 'admins', module: null,
    email: true, i18nKey: 'notif.securityApiCredentials',
  },
];

const BY_KEY = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t]));

export function notificationType(key: string): NotificationTypeDef | null {
  return BY_KEY.get(key) ?? null;
}

export const NOTIFICATION_KEYS = NOTIFICATION_TYPES.map((t) => t.key);

/** Orden de la bandeja: primero lo que más urge. */
export const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  critical: 0, high: 1, normal: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Fila tal como viaja a la UI
// ─────────────────────────────────────────────────────────────────────────────

export interface AppNotification {
  id: string;
  company_id: string | null;
  type: string;
  severity: NotificationSeverity;
  /** Valores para interpolar en el texto i18n (montos, nombres, fechas). */
  params: Record<string, string>;
  /** Adónde lleva el click, o null si no hay pantalla que mostrar. */
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * Notificaciones ordenadas para mostrar: no leídas primero, después por
 * severidad y por fecha. La UI y cualquier resumen tienen que coincidir, así
 * que el orden se decide acá y no en cada pantalla.
 */
export function sortNotifications(rows: AppNotification[]): AppNotification[] {
  return [...rows].sort((a, b) => {
    const readA = a.read_at ? 1 : 0;
    const readB = b.read_at ? 1 : 0;
    if (readA !== readB) return readA - readB;
    const sevA = SEVERITY_RANK[a.severity] ?? 9;
    const sevB = SEVERITY_RANK[b.severity] ?? 9;
    if (sevA !== sevB) return sevA - sevB;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}

export function unreadCount(rows: AppNotification[]): number {
  return rows.filter((r) => !r.read_at).length;
}
