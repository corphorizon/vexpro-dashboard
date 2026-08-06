// ─────────────────────────────────────────────────────────────────────────────
// Etiquetas de rol de la fuerza comercial.
//
// Este archivo llegó a tener 33 perfiles "demo" hardcodeados — con nombres y
// emails PERSONALES REALES del equipo — que viajaban en el bundle del cliente
// a cualquier visitante, aunque nadie los importaba (auditoría 2026-08-06,
// RRHH). Los datos reales viven en la base y llegan por data-context con RLS;
// acá quedó solo lo que las pantallas efectivamente usan.
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_LABELS_MAP: Record<string, string> = {
  sales_manager: 'Sales Manager',
  head: 'HEAD',
  bdm: 'BDM',
  bdm_global: 'BDM GLOBAL',
};

// Devuelve la etiqueta para roles conocidos; para el resto, capitaliza.
// (El CHECK de commercial_profiles.role se eliminó en la migración 011, así
// que pueden aparecer roles libres — mejor mostrarlos legibles que romper.)
export const ROLE_LABELS_HR = new Proxy(ROLE_LABELS_MAP, {
  get(target, prop: string) {
    return target[prop] || prop.charAt(0).toUpperCase() + prop.slice(1);
  },
});
