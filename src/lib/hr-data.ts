// ─────────────────────────────────────────────────────────────────────────────
// Etiquetas de rol de la fuerza comercial — REEXPORTE, no una segunda lista.
//
// Este archivo llegó a tener 33 perfiles "demo" hardcodeados — con nombres y
// emails PERSONALES REALES del equipo — que viajaban en el bundle del cliente
// a cualquier visitante, aunque nadie los importaba (auditoría 2026-08-06,
// RRHH). Los datos reales viven en la base y llegan por data-context con RLS.
//
// El 2026-08-31 el mapa de etiquetas se mudó al registro único del dominio
// (src/lib/hr/domain.ts), junto con la jerarquía y los predicados que estaban
// repetidos a mano en rrhh/page.tsx. Acá queda sólo el reexporte para no
// reescribir los seis imports del módulo. Nada nuevo va en este archivo: si
// hace falta un rol, una etiqueta o un color, va en `hr/domain.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export { ROLE_LABELS_HR } from '@/lib/hr/domain';
