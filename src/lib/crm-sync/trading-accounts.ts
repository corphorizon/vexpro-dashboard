// ─────────────────────────────────────────────────────────────────────────────
// Espejo de las cuentas de trading del CRM.
//
// ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
// MetaTrader y el CRM no tienen las mismas cuentas. Medido el 2026-08-26:
//
//     cuentas reales en MT5      24.415
//     cuentas live en el CRM     23.275
//     diferencia                  1.140   <-- pruebas que nunca llegaron al CRM
//
// Esas 1.140 operan igual que cualquier otra: tienen posiciones abiertas y
// generan PNL. Si nadie las excluye, entran a las cifras como si fueran
// clientes, y no hay nada en el dato de MT5 que las delate.
//
// El CRM es el criterio: cuenta que no está acá, no cuenta.
//
// ── POR QUÉ SE ESPEJA Y NO SE CONSULTA AL VUELO ────────────────────────────
// Porque el filtro se aplica en CADA corrida de PNL, y son 15 minutos. Traer
// 31.000 documentos de Mongo cada vez para descartar 1.140 logins es pagar un
// viaje a Orion por un dato que cambia cuando alguien abre una cuenta.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';

/** Los ÚNICOS campos que se piden. La proyección es la aduana: las contraseñas
 *  de MT5 viven en esta misma colección y no tienen por qué salir de Orion. */
export const ORION_ACCOUNT_FIELDS = [
  'accountId',
  'userId',
  'userEmail',
  'type',
  'status',
  'real',
  'serverName',
  'groupName',
] as const;

export interface TradingAccountsResult {
  fetched: number;
  upserted: number;
  live: number;
  skippedNoLogin: number;
  elapsedMs: number;
  warnings: string[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * `accountId` llega como texto en Orion. Se convierte a número porque del lado
 * de MT5 el login es entero, y comparar '100089' con 100089 no da nunca.
 */
function loginOf(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function syncTradingAccounts(
  admin: SupabaseClient,
  companyId: string,
): Promise<TradingAccountsResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const docs = await withOrionMongo(companyId, async ({ db }) =>
    db
      .collection('tradingaccounts')
      .find(
        {},
        {
          projection: Object.fromEntries(
            ORION_ACCOUNT_FIELDS.map((f) => [f, 1]),
          ) as Record<string, 1>,
          maxTimeMS: 180_000,
        },
      )
      .toArray(),
  );

  const now = new Date().toISOString();
  let skippedNoLogin = 0;

  // Un mismo login puede venir repetido si Orion tiene el documento duplicado.
  // Se queda el último: mandar dos filas con la misma clave al upsert hace que
  // Postgres rechace el lote entero con "ON CONFLICT ... affect row a second time".
  const porLogin = new Map<number, Record<string, unknown>>();

  for (const d of docs) {
    const login = loginOf((d as Record<string, unknown>).accountId);
    if (login === null) {
      skippedNoLogin += 1;
      continue;
    }
    const email = (d as Record<string, unknown>).userEmail;
    porLogin.set(login, {
      company_id: companyId,
      login,
      user_external_id: d.userId ? String(d.userId) : null,
      email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null,
      account_type: d.type ? String(d.type) : null,
      status: d.status ? String(d.status) : null,
      // `real` es booleano en Orion. Cualquier otra cosa se trata como NO live:
      // ante la duda, la cuenta queda fuera de las cifras en vez de entrar.
      is_live: (d as Record<string, unknown>).real === true,
      server_name: d.serverName ? String(d.serverName) : null,
      group_name: d.groupName ? String(d.groupName) : null,
      synced_at: now,
    });
  }

  const payload = [...porLogin.values()];

  let upserted = 0;
  for (const part of chunk(payload, 500)) {
    const { error } = await admin
      .from('crm_trading_accounts')
      .upsert(part, { onConflict: 'company_id,login' });
    if (error) throw new Error(`crm_trading_accounts: ${error.message}`);
    upserted += part.length;
  }

  if (skippedNoLogin > 0) {
    warnings.push(
      `${skippedNoLogin} cuenta(s) del CRM sin accountId numérico: no se pueden cruzar con MT5.`,
    );
  }
  const duplicados = docs.length - skippedNoLogin - payload.length;
  if (duplicados > 0) {
    warnings.push(`${duplicados} documento(s) de Orion comparten login: se guardó el último de cada uno.`);
  }

  return {
    fetched: docs.length,
    upserted,
    live: payload.filter((p) => p.is_live === true).length,
    skippedNoLogin,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
