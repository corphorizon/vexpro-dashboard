// ─────────────────────────────────────────────────────────────────────────────
// Validación y desarmado de la connection string de MongoDB (CRM Orion).
//
// A diferencia de MT5, acá el secreto es UNA sola cosa: la URI completa, que
// ya lleva usuario, contraseña, hosts, replica set y opciones. Se cifra entera
// y NUNCA vuelve al cliente. Lo único que sale al panel es el "host_hint"
// (la parte de hosts, sin credenciales) y el nombre de la base.
//
// Funciones puras: las comparte el upsert (validar antes de cifrar), el
// resolver (leer lo guardado) y los tests.
// ─────────────────────────────────────────────────────────────────────────────

export type MongoParseResult =
  | { ok: true; value: MongoUriParts }
  | { ok: false; error: string };

export interface MongoUriParts {
  /** URI normalizada (trim). Secreta: no sale nunca al cliente. */
  uri: string;
  /** 'mongodb' o 'mongodb+srv'. */
  scheme: 'mongodb' | 'mongodb+srv';
  /** Hosts SIN credenciales — apto para mostrar/guardar en extra_config. */
  hostHint: string;
  /** Base indicada en el path de la URI, si la trae. */
  uriDatabase: string | null;
}

/**
 * Valida el esquema y desarma la URI a mano.
 *
 * No usamos `new URL()` porque una URI de replica set lleva varios hosts
 * separados por coma (`mongodb://a:27017,b:27017/db`) y el parser de WHATWG
 * la rechaza o la deforma.
 */
export function parseMongoUri(raw: unknown): MongoParseResult {
  const uri = typeof raw === 'string' ? raw.trim() : '';
  if (!uri) return { ok: false, error: 'Orion Mongo: la connection string es obligatoria.' };

  const m = /^(mongodb\+srv|mongodb):\/\//i.exec(uri);
  if (!m) {
    return {
      ok: false,
      error: 'Orion Mongo: la connection string debe empezar con mongodb:// o mongodb+srv://',
    };
  }
  const scheme = m[1].toLowerCase() as 'mongodb' | 'mongodb+srv';

  const rest = uri.slice(m[0].length);
  // El "authority" termina en la primera / (path) o ? (opciones).
  const stops = [rest.indexOf('/'), rest.indexOf('?')].filter((i) => i >= 0);
  const authorityEnd = stops.length > 0 ? Math.min(...stops) : rest.length;
  const authority = rest.slice(0, authorityEnd);

  // lastIndexOf: la contraseña puede contener '@' codificado o no.
  const at = authority.lastIndexOf('@');
  const hosts = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hosts.trim()) {
    return { ok: false, error: 'Orion Mongo: la connection string no incluye ningún host.' };
  }
  if (/\s/.test(hosts)) {
    return { ok: false, error: 'Orion Mongo: el host de la connection string tiene espacios.' };
  }

  // Base en el path (mongodb://host/orion?opts) — opcional.
  let uriDatabase: string | null = null;
  if (rest[authorityEnd] === '/') {
    const afterSlash = rest.slice(authorityEnd + 1);
    const q = afterSlash.indexOf('?');
    const dbSegment = (q >= 0 ? afterSlash.slice(0, q) : afterSlash).trim();
    if (dbSegment) uriDatabase = decodeURIComponent(dbSegment);
  }

  return { ok: true, value: { uri, scheme, hostHint: hosts, uriDatabase } };
}

/**
 * Quita del texto de un error cualquier rastro de la URI o de sus credenciales.
 * El driver de Mongo incluye la URI entera en varios de sus mensajes.
 */
export function redactMongoError(message: string, uri: string | null | undefined): string {
  let out = message;
  if (uri) {
    out = out.split(uri).join('«connection string oculta»');
    const parsed = parseMongoUri(uri);
    if (parsed.ok) {
      // Por si el driver reescribió la URI (normaliza opciones): al menos
      // borramos el tramo usuario:contraseña@.
      out = out.replace(/mongodb(\+srv)?:\/\/[^\s]*@/gi, 'mongodb://«credenciales ocultas»@');
    }
  }
  out = out.replace(/\/\/[^\s/@]+:[^\s/@]+@/g, '//«credenciales ocultas»@');
  return out;
}
