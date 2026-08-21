// ─────────────────────────────────────────────────────────────────────────────
// Lector base del MongoDB del CRM Orion.
//
// Mismas reglas que el lector SQL de MT5:
//   · Un cliente por invocación (maxPoolSize 1 — en serverless un pool grande
//     sólo sirve para agotar las conexiones del cluster del broker).
//   · Timeouts cortos: 8 s para elegir servidor, 15 s de socket.
//   · Cierre garantizado en `finally`.
//   · Errores redactados: el driver mete la connection string ENTERA (con
//     usuario y contraseña) en varios de sus mensajes.
//
// El acceso es de SOLO LECTURA por contrato: el usuario del CRM debe tener rol
// `read`. Mongo no tiene un equivalente a "SET TRANSACTION READ ONLY", así que
// acá la garantía es el rol + el veredicto del probe; este módulo simplemente
// no expone ninguna operación de escritura.
//
// Fase 1: conexión DIRECTA, sin proxy TCP.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { Db, MongoClient } from 'mongodb';
import { resolveOrionMongoCredentials } from '../credentials';
import { redactMongoError } from './validate';

export const ORION_MONGO_SERVER_SELECTION_TIMEOUT_MS = 8_000;
export const ORION_MONGO_SOCKET_TIMEOUT_MS = 15_000;

/** Error ya redactado (sin URI ni credenciales), listo para el panel. */
export class OrionMongoError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'OrionMongoError';
    this.code = code;
  }
}

export interface OrionMongoSession {
  db: Db;
  client: MongoClient;
  /** Nombre efectivo de la base (extra_config.database o el path de la URI). */
  databaseName: string;
}

/**
 * Abre el cliente con las credenciales del tenant y ejecuta `fn`.
 * Lanza OrionMongoError si la empresa no tiene la credencial cargada.
 */
export async function withOrionMongo<T>(
  companyId: string,
  fn: (session: OrionMongoSession) => Promise<T>,
): Promise<T> {
  const creds = await resolveOrionMongoCredentials(companyId);
  if (!creds) {
    throw new OrionMongoError('Orion MongoDB no configurado para esta empresa', 'NOT_CONFIGURED');
  }

  const { MongoClient: Ctor } = await import('mongodb');
  let client: MongoClient | null = null;
  try {
    client = new Ctor(creds.uri, {
      serverSelectionTimeoutMS: ORION_MONGO_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: ORION_MONGO_SOCKET_TIMEOUT_MS,
      connectTimeoutMS: ORION_MONGO_SERVER_SELECTION_TIMEOUT_MS,
      // Serverless: una conexión por invocación. Sin esto el driver abre un
      // pool de 100 que muere con la función y deja sockets colgando del lado
      // del broker.
      maxPoolSize: 1,
      // Identificarnos ayuda al DBA del broker a ver quién consulta.
      appName: 'financial-dashboard',
    });
    await client.connect();

    // Si no hay base ni en extra_config ni en la URI, el driver usa la del
    // path; db() sin argumento devolvería 'test'. Preferimos fallar claro.
    if (!creds.database) {
      throw new OrionMongoError(
        'Orion MongoDB: falta el nombre de la base (ponelo en el campo "Base de datos" o en la connection string).',
        'NO_DATABASE',
      );
    }

    const db = client.db(creds.database);
    return await fn({ db, client, databaseName: creds.database });
  } catch (err) {
    if (err instanceof OrionMongoError) throw err;
    const raw = err instanceof Error ? err.message : String(err);
    const code =
      typeof (err as { codeName?: unknown })?.codeName === 'string'
        ? (err as { codeName: string }).codeName
        : typeof (err as { code?: unknown })?.code === 'string'
          ? (err as { code: string }).code
          : null;
    throw new OrionMongoError(redactMongoError(raw, creds.uri), code);
  } finally {
    await client?.close().catch(() => {});
  }
}
