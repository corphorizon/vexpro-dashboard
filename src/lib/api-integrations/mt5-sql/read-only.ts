// ─────────────────────────────────────────────────────────────────────────────
// Veredicto de SOLO LECTURA sobre la réplica SQL de MT5.
//
// Regla del proyecto: el dashboard nunca escribe en la base del broker. La
// forma de garantizarlo no es "portarse bien" en el código sino que el usuario
// que nos den tenga únicamente SELECT. Este módulo mira los permisos REALES
// que reporta el motor y emite el veredicto; nunca ejecuta una escritura de
// prueba (eso sería exactamente lo que queremos evitar).
//
// Funciones puras para que los tests puedan cubrir todos los formatos de grant
// sin una base de datos.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadOnlyVerdict {
  verdict: 'ok' | 'ESCRITURA DETECTADA';
  detail: string;
}

/** Privilegios que implican escritura o cambio de esquema. */
const WRITE_PRIVILEGES = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'TRIGGER',
  'LOAD FROM S3',
  'SELECT INTO S3',
];

/** ¿Este token de privilegio implica escritura? 'ALL PRIVILEGES' incluido. */
function isWritePrivilege(token: string): boolean {
  const t = token.trim().toUpperCase().replace(/\s+/g, ' ');
  if (t === 'ALL' || t.startsWith('ALL PRIVILEGES')) return true;
  return WRITE_PRIVILEGES.some((p) => t === p || t.startsWith(`${p} (`));
}

/**
 * MySQL/MariaDB: filas de `SHOW GRANTS FOR CURRENT_USER()`, del estilo
 *   GRANT SELECT ON `mt5`.* TO `lector`@`%`
 *   GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`
 *
 * Se mira SOLO el tramo entre "GRANT" y " ON " — el resto (nombre de la base,
 * del usuario) puede contener cualquier palabra y daría falsos positivos.
 */
export function mysqlGrantsVerdict(grantLines: string[]): ReadOnlyVerdict {
  const offending: string[] = [];

  for (const line of grantLines) {
    if (typeof line !== 'string') continue;
    const m = /^\s*GRANT\s+([\s\S]*?)\s+ON\s/i.exec(line);
    if (!m) continue; // GRANT `rol` TO `usuario` y similares: no dice nada de escritura.
    const privileges = splitPrivilegeList(m[1]);
    const writes = privileges.filter(isWritePrivilege);
    if (writes.length > 0) {
      offending.push(`${writes.join(', ')} (${line.trim().slice(0, 120)})`);
    }
  }

  if (offending.length > 0) {
    return {
      verdict: 'ESCRITURA DETECTADA',
      detail: `El usuario tiene permisos de escritura: ${offending.join(' · ')}. Pedí al hosting un usuario de SOLO LECTURA (sólo SELECT).`,
    };
  }
  return {
    verdict: 'ok',
    detail:
      grantLines.length > 0
        ? 'SHOW GRANTS sólo devuelve permisos de lectura.'
        : 'SHOW GRANTS no devolvió filas: sin permisos de escritura visibles.',
  };
}

/**
 * Separa "SELECT, INSERT (col1, col2), UPDATE" respetando los paréntesis:
 * MySQL lista los privilegios por columna entre paréntesis y una coma dentro
 * de ellos no separa privilegios.
 */
function splitPrivilegeList(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * PostgreSQL: valores de `privilege_type` de information_schema.role_table_grants
 * para el usuario actual (SELECT / INSERT / UPDATE / DELETE / TRUNCATE /
 * REFERENCES / TRIGGER). Acá no hay que parsear nada: el motor ya normalizó.
 */
export function postgresGrantsVerdict(
  rows: Array<{ privilege_type?: string | null; table_name?: string | null }>,
): ReadOnlyVerdict {
  const writes = rows.filter((r) => isWritePrivilege(String(r.privilege_type ?? '')));
  if (writes.length > 0) {
    const sample = writes
      .slice(0, 6)
      .map((r) => `${r.privilege_type} en ${r.table_name ?? '?'}`)
      .join(', ');
    return {
      verdict: 'ESCRITURA DETECTADA',
      detail: `El usuario tiene permisos de escritura (${writes.length} en total): ${sample}. Pedí al hosting un usuario de SOLO LECTURA (sólo SELECT).`,
    };
  }
  return {
    verdict: 'ok',
    detail:
      rows.length > 0
        ? `role_table_grants sólo devuelve lectura (${rows.length} permisos SELECT).`
        : 'role_table_grants no devolvió permisos de escritura.',
  };
}
