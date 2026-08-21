// ─────────────────────────────────────────────────────────────────────────────
// Veredicto de SOLO LECTURA sobre el MongoDB del CRM Orion.
//
// Fuente: db.admin().command({ connectionStatus: 1, showPrivileges: true }),
// que devuelve los roles del usuario autenticado y, si el servidor lo permite,
// la lista expandida de privilegios (acciones por recurso).
//
// Preferimos los PRIVILEGIOS sobre los roles cuando están: un rol a medida de
// Atlas puede llamarse cualquier cosa y sólo las acciones dicen la verdad. Si
// no hay privilegios, caemos a la lista de roles conocidos.
//
// Funciones puras — cero red, cubiertas por tests.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReadOnlyVerdict } from '../mt5-sql/read-only';

export type { ReadOnlyVerdict };

export interface MongoAuthRole {
  role?: string | null;
  db?: string | null;
}

export interface MongoAuthPrivilege {
  resource?: unknown;
  actions?: string[] | null;
}

/** Roles integrados que sólo leen. Todo lo demás que no sea de esta lista escribe. */
const READ_ONLY_ROLES = new Set([
  'read',
  'readanydatabase',
  'clustermonitor',
  'atlasreadonly',
]);

/** Roles integrados que sí escriben (o pueden). Sólo para el detalle. */
const KNOWN_WRITE_ROLES = new Set([
  'readwrite',
  'readwriteanydatabase',
  'dbadmin',
  'dbadminanydatabase',
  'dbowner',
  'useradmin',
  'useradminanydatabase',
  'clusteradmin',
  'clustermanager',
  'hostmanager',
  'backup',
  'restore',
  'root',
  '__system',
  'atlasadmin',
]);

/** Acciones de Mongo que modifican datos o esquema. */
const WRITE_ACTIONS = new Set([
  'insert',
  'update',
  'remove',
  'createcollection',
  'createindex',
  'dropcollection',
  'dropdatabase',
  'dropindex',
  'renamecollectionsamedb',
  'convertocapped',
  'converttocapped',
  'emptycapped',
  'createuser',
  'dropuser',
  'grantrole',
  'revokerole',
  'createrole',
  'droprole',
  'bypassdocumentvalidation',
  'compact',
  'shardcollection',
  'out',
  'anyaction',
]);

/**
 * Veredicto combinado. `privileges` manda si viene con contenido; si no, se
 * juzga por roles.
 */
export function mongoReadOnlyVerdict(input: {
  roles: MongoAuthRole[];
  privileges?: MongoAuthPrivilege[] | null;
}): ReadOnlyVerdict {
  const roles = Array.isArray(input.roles) ? input.roles : [];
  const roleLabel = roles.map((r) => `${r.role ?? '?'}@${r.db ?? '?'}`).join(', ') || 'ninguno';

  const privileges = Array.isArray(input.privileges) ? input.privileges : [];
  if (privileges.length > 0) {
    const found = new Set<string>();
    for (const p of privileges) {
      for (const a of p.actions ?? []) {
        if (typeof a === 'string' && WRITE_ACTIONS.has(a.toLowerCase())) found.add(a);
      }
    }
    if (found.size > 0) {
      return {
        verdict: 'ESCRITURA DETECTADA',
        detail: `El usuario puede escribir (acciones: ${[...found].slice(0, 8).join(', ')}). Roles: ${roleLabel}. Pedí al CRM un usuario de SOLO LECTURA (rol read).`,
      };
    }
    return {
      verdict: 'ok',
      detail: `Ninguna acción de escritura en los privilegios expandidos. Roles: ${roleLabel}.`,
    };
  }

  // Sin privilegios expandidos → juicio por roles conocidos. Un rol a medida
  // que no reconocemos se trata como sospechoso: no podemos garantizar nada.
  const suspicious = roles
    .map((r) => String(r.role ?? '').toLowerCase())
    .filter((r) => r && !READ_ONLY_ROLES.has(r));

  if (suspicious.length > 0) {
    const known = suspicious.filter((r) => KNOWN_WRITE_ROLES.has(r));
    const custom = suspicious.filter((r) => !KNOWN_WRITE_ROLES.has(r));
    const parts: string[] = [];
    if (known.length > 0) parts.push(`roles con escritura: ${known.join(', ')}`);
    if (custom.length > 0) {
      parts.push(`roles a medida que no puedo verificar: ${custom.join(', ')}`);
    }
    return {
      verdict: 'ESCRITURA DETECTADA',
      detail: `${parts.join(' · ')}. Pedí al CRM un usuario de SOLO LECTURA (rol read sobre la base del CRM).`,
    };
  }

  return {
    verdict: 'ok',
    detail:
      roles.length > 0
        ? `Sólo roles de lectura: ${roleLabel}.`
        : 'El servidor no reportó roles: sin permisos de escritura visibles.',
  };
}
