// ─────────────────────────────────────────────────────────────────────────────
// MODO ARCHIVO — Smart Dashboard queda como archivo de consulta.
//
// POR QUÉ (Kevin, 2026-10-20)
// «Apaga Smart Dashboard, que solo sirva como visual y guarde los datos hasta
// que los recibió». Las 6 primeras empresas ya se mudaron a Atlas
// (atlas.exuraglobal.com) el 2026-10-18 y las 2 Exura se mudan ahora. Desde
// el merge de esto, SD:
//   · NO recibe datos nuevos: crons, syncs manuales y lecturas en vivo de
//     proveedores (PSP, on-chain, CRM, MT5) responden 410 sin tocar nada;
//   · NADIE escribe: toda ruta /api con POST/PUT/PATCH/DELETE responde 410,
//     salvo el acceso (login, 2FA, salida, reset de contraseña);
//   · muestra los datos tal como estaban a la fecha de corte.
//
// DÓNDE SE APLICA (una sola decisión, tres lugares que la leen)
//   1. src/middleware.ts → `archiveBlock()` corta antes de llegar a la ruta.
//      Es la defensa real: no depende de que cada handler se acuerde.
//   2. src/lib/api-fetch.ts → el cliente ni siquiera manda la escritura
//      (misma respuesta 410, sin viaje de red).
//   3. La UI → los helpers de permisos de escritura (canAdd/canEdit/
//      canDelete/isCompanyAdmin en auth-context, roleCanWrite* en roles.ts)
//      devuelven false, así los botones de crear/editar/borrar/cerrar/subir
//      no se dibujan; y canAccessModule oculta los módulos que sólo existen
//      para escribir o que consultan en vivo (ARCHIVE_HIDDEN_MODULES).
//
// WEBHOOKS ENTRANTES (Pay-Pros es el único que hay): NO se cortan con 410 en
// el middleware. Pay-Pros trata cualquier cosa que no sea 200 + «ingoing
// string» firmado como entrega fallida y reintenta. La ruta responde 200
// firmado SIN escribir nada en la base y deja el body crudo en el log y en
// Sentry, para que un aviso que llegue tarde no se pierda del todo. Ver
// src/app/api/webhooks/paypros/[token]/route.ts. Lo correcto es repuntar el
// webhook a Atlas (o darlo de baja) en el panel de Pay-Pros.
//
// DESCARTADO: una variable de entorno (ARCHIVE_MODE=1). Pedido explícito:
// el interruptor va en código para que el merge lo active y nadie lo apague
// por accidente cambiando una variable en Vercel. Volver atrás = un PR.
// ─────────────────────────────────────────────────────────────────────────────

import { ATLAS_HOST, ATLAS_URL, isMigratedToAtlas } from './atlas-migration';

/** Interruptor central. En código a propósito (ver cabecera). */
export const ARCHIVE_MODE: boolean = true;

/**
 * Fecha de corte: hasta aquí llegan los datos de Smart Dashboard. La fija la
 * cabeza del proyecto; se muestra en el aviso tal cual (AAAA-MM-DD).
 */
export const ARCHIVE_CUTOFF_DATE = '2026-10-20';


export const ARCHIVE_MESSAGE = `Smart Dashboard está archivado: solo consulta, con los datos hasta el ${ARCHIVE_CUTOFF_DATE}. Todo el trabajo sigue en Atlas: ${ATLAS_HOST}`;

/** Código de error estable para que el cliente lo distinga de otros 410. */
export const ARCHIVE_ERROR_CODE = 'archived';

/**
 * Escrituras que SIGUEN permitidas: sólo lo necesario para entrar a consultar.
 * Prefijos exactos de ruta (sin barra final). Todo lo demás, 410.
 *
 * · login-gate / verify-2fa / setup-2fa / verify-pin / login-notification:
 *   el flujo de inicio de sesión (verify-pin es la re-verificación 2FA que
 *   piden las exportaciones a CSV/PDF, que son lecturas).
 * · 2fa-seal (DELETE): lo llama el cierre de sesión.
 * · forgot-password / reset-password-confirm / request-2fa-reset /
 *   confirm-2fa-reset: recuperar el acceso sin un admin.
 *
 * El cierre de sesión en sí (supabase.auth.signOut) y el cambio de
 * contraseña (supabase.auth.updateUser) van directo a Supabase Auth desde el
 * navegador: no pasan por /api.
 *
 * Quedan FUERA a propósito: reset de contraseña/2FA hecho por un admin a otro
 * usuario, alta/baja de usuarios, idioma, notificaciones leídas, asistente IA,
 * auditoría desde el navegador. Si hace falta recuperar a alguien, Supabase
 * Auth o Atlas.
 */
export const ARCHIVE_WRITE_ALLOWLIST: readonly string[] = Object.freeze([
  '/api/auth/login-gate',
  '/api/auth/verify-2fa',
  '/api/auth/setup-2fa',
  '/api/auth/verify-pin',
  '/api/auth/login-notification',
  '/api/auth/2fa-seal',
  '/api/auth/forgot-password',
  '/api/auth/reset-password-confirm',
  '/api/auth/request-2fa-reset',
  '/api/auth/confirm-2fa-reset',
]);

/**
 * Webhooks entrantes: pasan el middleware y la propia ruta responde sin
 * escribir (ver cabecera). NO es una excepción de escritura.
 */
export const ARCHIVE_WEBHOOK_PREFIXES: readonly string[] = Object.freeze(['/api/webhooks/']);

/**
 * Ingesta: cortada con CUALQUIER método (los crons de Vercel llaman por GET).
 * · /api/cron/* — todos los crons de vercel.json.
 * · GET que leen en vivo del proveedor y además persisten (coinsbuy/wallets y
 *   unipayment/balances guardan snapshot de saldo; movements guarda el
 *   dataset), o que abren conexión a un sistema externo (on-chain, CRM, MT5,
 *   FairPay). Archivado = «los datos tal como estaban»: lo vivo no aplica.
 *   Las pantallas ya caen a lo persistido cuando esto falla.
 */
export const ARCHIVE_INGEST_PREFIXES: readonly string[] = Object.freeze([
  '/api/cron/',
  '/api/integrations/movements',
  '/api/integrations/coinsbuy/',
  '/api/integrations/unipayment/',
  '/api/integrations/fairpay/',
  '/api/integrations/orion-crm/',
  '/api/admin/onchain-live',
  '/api/superadmin/mt5-sql-probe',
  '/api/superadmin/orion-mongo-probe',
  '/api/superadmin/fairpay-probe',
  '/api/superadmin/fairpay-banking-probe',
  '/api/superadmin/liquidity/diagnostico-mt5',
]);

/**
 * Módulos que se ocultan del menú y de las rutas en modo archivo:
 * · upload — la carga de datos sólo existe para escribir.
 * · assistant — el chat es POST y guarda conversaciones.
 */
export const ARCHIVE_HIDDEN_MODULES: ReadonlySet<string> = new Set(['upload', 'assistant']);

/**
 * API de socio (token de partner) — interruptor APARTE, abierto por ahora.
 *
 * Atlas TODAVÍA lee MT5 (y quizás Orion) por aquí con un token de socio
 * contra dashboard.horizonconsulting.ai (proveedor «MT5» de Atlas,
 * src/lib/support/mt5Config.ts allá). Cortarlo hoy dejaría a Atlas sin esos
 * datos. Cuando Atlas ya no dependa, la cabeza lo pone en `false` y estas
 * rutas responden 410 con cualquier método.
 *
 * OJO: estas rutas sirven lo ESPEJADO (mt5_account_activity,
 * crm_customer_aggregates, crm_user_snapshots), que llenaba el cron
 * /api/cron/sync-crm. Con los crons apagados, lo que reciba Atlas queda
 * congelado a la fecha de corte (cada respuesta trae `asOf`, así que se ve).
 */
export const ARCHIVE_PARTNER_API_OPEN: boolean = true;

/** Rutas que se autentican con token de socio (partner_api_tokens). */
export const ARCHIVE_PARTNER_PREFIXES: readonly string[] = Object.freeze(['/api/partner/']);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export type ArchiveDecision =
  | { blocked: false }
  | { blocked: true; reason: ArchiveReason };

export type ArchiveReason = 'ingest' | 'write' | 'partner';

/**
 * Decisión pura: ¿esta petición se corta en modo archivo?
 * `archived` se inyecta para poder testear los dos estados.
 */
export function archiveDecision(
  method: string,
  pathname: string,
  archived: boolean = ARCHIVE_MODE,
  partnerOpen: boolean = ARCHIVE_PARTNER_API_OPEN,
): ArchiveDecision {
  if (!archived) return { blocked: false };
  // Normaliza la barra final: /api/cron/x/ y /api/cron/x son la misma ruta.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!path.startsWith('/api/') && path !== '/api') return { blocked: false };

  if (ARCHIVE_PARTNER_PREFIXES.some((p) => matchesPrefix(path, p))) {
    // Las rutas de socio son GET de lectura. Abiertas → pasan sin más (no son
    // una excepción de escritura: un POST igual cae abajo como 'write').
    if (!partnerOpen) return { blocked: true, reason: 'partner' };
  }
  if (ARCHIVE_INGEST_PREFIXES.some((p) => matchesPrefix(path, p))) {
    return { blocked: true, reason: 'ingest' };
  }
  if (READ_METHODS.has(method.toUpperCase())) return { blocked: false };
  if (ARCHIVE_WEBHOOK_PREFIXES.some((p) => matchesPrefix(path, p))) return { blocked: false };
  if (ARCHIVE_WRITE_ALLOWLIST.some((p) => matchesPrefix(path, p))) return { blocked: false };
  return { blocked: true, reason: 'write' };
}

/** Cuerpo JSON de la respuesta 410 (compatible con `{ success, error }`). */
export function archiveBody(reason: ArchiveReason) {
  return {
    success: false,
    error: ARCHIVE_MESSAGE,
    code: ARCHIVE_ERROR_CODE,
    reason,
    cutoffDate: ARCHIVE_CUTOFF_DATE,
    atlasUrl: ATLAS_URL,
  };
}

/** Response 410 estándar (Web API: sirve en middleware, rutas y cliente). */
export function archiveResponse(reason: ArchiveReason): Response {
  return new Response(JSON.stringify(archiveBody(reason)), {
    status: 410,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Smart-Dashboard-Archived': ARCHIVE_CUTOFF_DATE,
    },
  });
}

/** Para el middleware: la 410 si corresponde, o null para seguir. */
export function archiveBlock(method: string, pathname: string): Response | null {
  const d = archiveDecision(method, pathname);
  return d.blocked ? archiveResponse(d.reason) : null;
}

/**
 * Para los helpers de permisos de la UI: en modo archivo nadie escribe.
 * `allowed` es lo que el rol permitiría sin archivo.
 */
export function writeAllowed(allowed: boolean): boolean {
  return ARCHIVE_MODE ? false : allowed;
}

/**
 * ¿Se muestra el aviso (banner fijo + modal al entrar)? En modo archivo, a
 * TODAS las empresas —incluidas las Exura— y también sin empresa activa
 * (superadmin en el panel). Sin archivo vuelve al criterio anterior: sólo las
 * empresas de MIGRATED_TO_ATLAS.
 */
export function archiveNoticeVisible(
  companyId: string | null | undefined,
  archived: boolean = ARCHIVE_MODE,
): boolean {
  return archived || isMigratedToAtlas(companyId);
}
