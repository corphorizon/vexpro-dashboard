// ─────────────────────────────────────────────────────────────────────────────
// Dominio del panel — registro ÚNICO.
//
// POR QUÉ (Kevin, 2026-10-15): «vamos a cambiar todo lo del dominio principal
// al sitio web exuraglobal.com ya que esta empresa será la que organice todo».
// El panel pasa de dashboard.horizonconsulting.ai a dashboard.exuraglobal.com
// (la raíz exuraglobal.com es el sitio web de Exura; atlas.exuraglobal.com es
// otro proyecto). Antes la URL de respaldo estaba copiada en 9 archivos.
//
// CÓMO SE MUDA, SIN CORTE:
//   1. Los dos dominios quedan en el proyecto de Vercel.
//   2. Mientras `CANONICAL_HOST` no esté definida, nada redirige: el dominio
//      viejo sigue funcionando igual.
//   3. Con el DNS del nuevo verificado se define CANONICAL_HOST (y
//      NEXT_PUBLIC_APP_URL) en Vercel: las PÁGINAS del dominio viejo pasan a
//      redirigir (308) al nuevo, conservando ruta y query.
//   4. `/api/*` NO se redirige nunca: el webhook de Pay-Pros está registrado
//      en el proveedor con la URL vieja y los proveedores de webhooks no
//      siguen redirecciones; los clientes de la API de partners (Atlas) usan
//      la base vieja. Los dos hosts sirven la API.
//
// La sesión de Supabase vive en el almacenamiento del navegador por origen:
// al pasar al dominio nuevo cada usuario inicia sesión una vez más.
// ─────────────────────────────────────────────────────────────────────────────

/** Empresa que opera la plataforma (firma de correos, metadatos). Antes
 *  «Horizon Consulting», copiado en 15 lugares. */
export const PLATFORM_ORG = 'Exura Global';

/** Remitente por defecto si SENDGRID_FROM_EMAIL no está definida. El dominio
 *  tiene que estar autenticado en SendGrid (registros em6718 / s1 / s2). */
export const DEFAULT_FROM_EMAIL = 'noreply@exuraglobal.com';

/** URL pública del panel cuando NEXT_PUBLIC_APP_URL no está definida. */
export const DEFAULT_APP_URL = 'https://dashboard.exuraglobal.com';

/** Hosts anteriores del panel: siguen sirviendo la API y redirigen las páginas. */
export const LEGACY_APP_HOSTS: readonly string[] = ['dashboard.horizonconsulting.ai'];

/** La URL pública del panel: la variable de entorno o el respaldo. */
export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL;
}

/**
 * Adónde redirigir una petición a un host viejo. `null` = no redirigir.
 * Pura, para poder testearla sin el middleware.
 */
export function canonicalRedirectUrl(args: {
  host: string | null;
  pathname: string;
  search: string;
  canonicalHost: string | null | undefined;
}): string | null {
  const canonical = args.canonicalHost?.trim().toLowerCase();
  if (!canonical || !args.host) return null;
  const host = args.host.toLowerCase().split(':')[0];
  if (host === canonical || !LEGACY_APP_HOSTS.includes(host)) return null;
  // La API sirve en los dos hosts (webhooks, API de partners).
  if (args.pathname === '/api' || args.pathname.startsWith('/api/')) return null;
  return `https://${canonical}${args.pathname}${args.search}`;
}
