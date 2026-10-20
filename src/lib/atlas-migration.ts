// ─────────────────────────────────────────────────────────────────────────────
// Empresas que se mudaron a Atlas — el aviso «Nos mudamos a Atlas».
//
// POR QUÉ (2026-10-20, pedido de Kevin)
// El 2026-10-18 se migraron a Atlas (atlas.exuraglobal.com) seis empresas.
// Smart Dashboard deja de actualizarse para ellas, pero sigue abierto y la
// gente entra por costumbre: sin un aviso, ve números que ya no se mueven y
// los toma por buenos — un dato congelado es indistinguible de un mes quieto
// (§1.2 de docs/reglas-del-proyecto.md).
//
// QUIÉN NO VE NADA: Exura Prime y Exura Liquidez SIGUEN aquí por decisión de
// Kevin. Por eso esto es una lista de las que SE FUERON (lista blanca), no de
// las que se quedan: una empresa nueva que se cree mañana no hereda el aviso
// por accidente.
//
// POR QUÉ POR ID Y NO POR SLUG: los ids salen de los manifiestos de la
// migración a prod (`sdCompanyId` en ~/dev/.fase5-manifiestos/prod-*.json, del
// 2026-10-18). Vex Pro y AP Markets coinciden además con ids que ya estaban en
// el repo (pinned-wallets.test.ts, migration-041). El slug de Atlas («vex-pro»)
// NO es el de Smart Dashboard («vexprofx»), así que el slug no servía como
// llave común; el id es estable y es lo que viaja en `company.id`.
//
// Esta es la ÚNICA lista (§1.1). Si otra empresa se muda, se agrega aquí.
// ─────────────────────────────────────────────────────────────────────────────

export const ATLAS_URL = 'https://atlas.exuraglobal.com';
export const ATLAS_HOST = 'atlas.exuraglobal.com';

/** Empresas de Smart Dashboard migradas a Atlas el 2026-10-18 (id → nombre). */
export const MIGRATED_TO_ATLAS: Readonly<Record<string, string>> = Object.freeze({
  '71715987-5479-52c4-a990-c414fb3a9b36': 'Vex Pro',
  '356ada44-b7af-4983-ac84-8685dcc8c22e': 'AP Markets',
  'f5c0a533-fca0-4b1e-8f42-c42f8f24d524': 'Horizon',
  'bf5cb9ea-b5c0-40b6-b3c7-60ad852f3114': 'Horizon Global',
  '25940fa9-807d-4868-a49b-06498d46c2c0': 'Horizon Atlas',
  'ad896227-7bad-426b-b1bf-2ca89e6473d3': 'Vonix',
});

/** ¿La empresa activa (la que se está mirando) ya se mudó a Atlas? */
export function isMigratedToAtlas(companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  return Object.prototype.hasOwnProperty.call(MIGRATED_TO_ATLAS, companyId.toLowerCase());
}

// ── «Ocultar durante esta sesión» ───────────────────────────────────────────
// El modal vuelve en CADA inicio de sesión (pedido explícito: no recordarlo
// para siempre). Se guarda en sessionStorage —muere con la pestaña— y además
// la llave lleva el usuario y la empresa: un superadmin que salta de Vex Pro a
// Vonix lo vuelve a ver, porque es otra mudanza. Al cerrar sesión se borra
// (auth-context, listener de SIGNED_OUT), así que volver a entrar en la misma
// pestaña también lo muestra.
// DESCARTADO: localStorage — sobrevive al logout y al reinicio del navegador,
// que es justo «recordarlo para siempre».

const DISMISS_PREFIX = 'fd_atlas_notice_dismissed:';

export function atlasNoticeDismissKey(userId: string, companyId: string): string {
  return `${DISMISS_PREFIX}${userId}:${companyId}`;
}

export function isAtlasNoticeDismissed(userId: string, companyId: string): boolean {
  try {
    return sessionStorage.getItem(atlasNoticeDismissKey(userId, companyId)) === '1';
  } catch {
    return false; // sin storage: se muestra (lo seguro es avisar de más)
  }
}

export function dismissAtlasNotice(userId: string, companyId: string): void {
  try {
    sessionStorage.setItem(atlasNoticeDismissKey(userId, companyId), '1');
  } catch {
    /* privacidad: se cierra igual en esta vista, sólo no se recuerda */
  }
}

/** Borra todas las marcas de «ya lo vi». Se llama al cerrar sesión. */
export function clearAtlasNoticeDismissals(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(DISMISS_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* sin storage no hay nada que borrar */
  }
}
