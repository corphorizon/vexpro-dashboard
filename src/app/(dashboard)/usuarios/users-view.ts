// ─────────────────────────────────────────────────────────────────────────────
// users-view — decisiones puras de /usuarios y /perfil («Libro mayor»,
// 2026-10-12).
//
// QUÉ DECIDE Y POR QUÉ
//   · `twofaKind`: 2FA activo = `ok` (al día); inactivo = `neutral`. Antes
//     esmeralda / pizarra con paleta cruda y `dark:`. El inactivo NO es
//     `pend`: el alta ya fuerza el setup en el primer login
//     (`force_2fa_setup`), así que no es una acción pendiente del admin.
//     Lo usan /usuarios y /perfil: UN mapa (reglas §1.1).
//   · `pendingActivationKind`: invitación sin aceptar = `pend` (requiere que
//     alguien haga algo: el usuario, o el admin reenviando).
//   · `splitModules`: la columna Módulos mostraba 4 chips + «+N». El recorte
//     ya se contaba; acá se fija con test y se expone la lista oculta para el
//     `title` (antes los ocultos no se podían ver sin abrir la edición).
//   · `usersListSuspect`: `fetchAllUsers` (lib/auth-context.tsx) devuelve
//     `[]` si la API falla — no hay forma de distinguirlo de «sin usuarios»
//     desde acá sin tocar lib (fuera de esta tanda). Pero una empresa con
//     alguien mirando /usuarios tiene AL MENOS a esa persona: una lista vacía
//     es por construcción «no cargó (o todavía no)». La pantalla lo dice en
//     vez de pintar «Usuarios (0)».
//   · `parseCustomRoles`: la carga de roles personalizados tenía un catch
//     vacío («non-fatal»). Lo sigue siendo, pero sin aviso el selector de rol
//     ofrecía sólo los del sistema y nadie sabía que faltaban los propios.
//     Un 403 NO es falla: el GET exige `requireAdmin` y un auditor/HR con el
//     módulo `users` lo recibe siempre — avisarle «no cargó» sería ruido
//     permanente. Se distingue como `forbidden` y no se avisa.
// ─────────────────────────────────────────────────────────────────────────────
import type { StatusKind } from '@/components/ui/status-kind';

export const MODULE_CHIPS_MAX = 4;

export function twofaKind(enabled: boolean | null | undefined): StatusKind {
  return enabled ? 'ok' : 'neutral';
}

export function pendingActivationKind(): StatusKind {
  return 'pend';
}

export function splitModules(mods: readonly string[], max = MODULE_CHIPS_MAX): { shown: string[]; hidden: string[] } {
  const safeMax = Math.max(0, Math.floor(max));
  return { shown: mods.slice(0, safeMax), hidden: mods.slice(safeMax) };
}

/** Lista de usuarios vacía con una sesión abierta = no cargó. */
export function usersListSuspect(users: readonly unknown[], hasSession: boolean): boolean {
  return hasSession && users.length === 0;
}

export type CustomRolesState = 'loading' | 'ok' | 'forbidden' | 'error';

/** Respuesta de GET /api/admin/custom-roles → estado + roles. */
export function parseCustomRoles<R>(
  status: number,
  ok: boolean,
  json: unknown,
): { state: CustomRolesState; roles: R[] } {
  if (status === 403) return { state: 'forbidden', roles: [] };
  if (!ok || json == null || typeof json !== 'object') return { state: 'error', roles: [] };
  const j = json as Record<string, unknown>;
  if (j.success !== true || !Array.isArray(j.roles)) return { state: 'error', roles: [] };
  return { state: 'ok', roles: j.roles as R[] };
}
