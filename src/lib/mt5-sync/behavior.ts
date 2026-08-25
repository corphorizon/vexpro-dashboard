// ─────────────────────────────────────────────────────────────────────────────
// Cómo opera cada cuenta: duración de las posiciones, si gana o pierde, y si
// parece un operador manual o un bot.
//
// ── POR QUÉ ESTO ES CARO Y SE ACOTA ────────────────────────────────────────
// Calcular cuánto dura una posición obliga a emparejar su entrada con su
// salida por `PositionID`, y `PositionID` NO está en el índice que cubre las
// consultas por cuenta. Medido: 60 cuentas tardan 16,7 s sobre las 68 millones
// de filas de mt5_deals.
//
// Por eso NO se calcula para las 26.000 cuentas: sólo para las de clientes con
// un retiro pendiente o reciente, que es donde alguien va a leer el dato.
//
// ── QUÉ SE PUEDE LEER DE ESTOS NÚMEROS, Y QUÉ NO ───────────────────────────
// Muchas posiciones de menos de un minuto significa scalping o un robot. NO
// significa abuso por sí solo: hay clientes que operan así legítimamente. Lo
// que hace es separar a un operador manual de uno automático, que es
// información que el analista no tiene por ningún otro lado.
//
// Medido en la primera corrida: una cuenta con 44.547 posiciones de las cuales
// 17.780 duraron menos de un minuto. Eso no lo hace una persona.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';
import { familyOf, unitOf } from '@/lib/partner-api/money';
import { round2 } from '@/lib/utils';

/**
 * Cuentas por consulta. Con 60 tardó 16,7 s; se mantiene chico a propósito
 * porque esta consulta va a la fila y no al índice.
 */
const LOGIN_BATCH = 60;

/** Techo de cuentas por corrida, para que el cron no se pase de su presupuesto. */
const MAX_LOGINS = 240;

export interface BehaviorResult {
  loginsRequested: number;
  loginsAnalyzed: number;
  rows: number;
  elapsedMs: number;
  warnings: string[];
}

interface DurRow {
  Login: unknown;
  posiciones: unknown;
  dur_media: unknown;
  menos_1min: unknown;
  menos_5min: unknown;
  ganadas: unknown;
  perdidas: unknown;
  bruto_ganado: unknown;
  bruto_perdido: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Etiqueta legible de la duración típica. Es lo que se muestra como
 * comentario, porque "412 segundos" no le dice nada a nadie y "minutos" sí.
 */
export function durationBucket(avgSeconds: number | null): string {
  if (avgSeconds === null) return 'sin dato';
  if (avgSeconds < 60) return 'segundos';
  if (avgSeconds < 900) return 'minutos';
  if (avgSeconds < 14400) return 'horas';
  if (avgSeconds < 172800) return 'un día';
  return 'días o más';
}

const sqlFor = (placeholders: string) =>
  [
    'SELECT Login,',
    '       COUNT(*) AS posiciones,',
    '       AVG(dur) AS dur_media,',
    '       SUM(CASE WHEN dur < 60 THEN 1 ELSE 0 END) AS menos_1min,',
    '       SUM(CASE WHEN dur < 300 THEN 1 ELSE 0 END) AS menos_5min,',
    '       SUM(CASE WHEN pl > 0 THEN 1 ELSE 0 END) AS ganadas,',
    '       SUM(CASE WHEN pl < 0 THEN 1 ELSE 0 END) AS perdidas,',
    '       SUM(CASE WHEN pl > 0 THEN pl ELSE 0 END) AS bruto_ganado,',
    '       SUM(CASE WHEN pl < 0 THEN pl ELSE 0 END) AS bruto_perdido',
    '  FROM (SELECT Login, PositionID,',
    '               TIMESTAMPDIFF(SECOND, MIN(TimeMsc), MAX(TimeMsc)) AS dur,',
    '               SUM(Profit) AS pl',
    '          FROM mt5_deals',
    `         WHERE Login IN (${placeholders}) AND Entry IN (0,1) AND PositionID > 0`,
    '         GROUP BY Login, PositionID',
    '        HAVING COUNT(*) >= 2) x',
    ' GROUP BY Login',
  ].join('\n');

/**
 * Analiza el comportamiento de las cuentas indicadas.
 *
 * `logins` viene ya acotado por el llamador: esta función NO decide el alcance
 * porque el costo depende enteramente de cuántas cuentas se le pasen.
 */
export async function syncTradingBehavior(
  admin: SupabaseClient,
  companyId: string,
  logins: Array<{ login: number; email: string | null; group: string | null }>,
): Promise<BehaviorResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const acotado = logins.slice(0, MAX_LOGINS);
  if (acotado.length < logins.length) {
    // Un techo silencioso haría creer que se analizó todo. Se dice.
    warnings.push(
      `Se analizaron ${acotado.length} de ${logins.length} cuentas: el resto queda para la próxima corrida.`,
    );
  }
  if (acotado.length === 0) {
    return { loginsRequested: 0, loginsAnalyzed: 0, rows: 0, elapsedMs: Date.now() - started, warnings };
  }

  const meta = new Map(acotado.map((l) => [String(l.login), l]));

  const filas = await withMt5Connection(companyId, async (session: Mt5Session) => {
    const out: DurRow[] = [];
    for (const part of chunk(acotado.map((l) => String(l.login)), LOGIN_BATCH)) {
      const ph = part.map(() => '?').join(',');
      out.push(...(await session.query<DurRow>(sqlFor(ph), part)));
    }
    return out;
  });

  const now = new Date().toISOString();
  const payload = filas.map((r) => {
    const login = String(num(r.Login) ?? 0);
    const m = meta.get(login);
    const family = familyOf(m?.group ?? null);
    const media = num(r.dur_media);
    return {
      company_id: companyId,
      login: Number(login),
      email: m?.email ?? null,
      positions: num(r.posiciones) ?? 0,
      avg_duration_s: media === null ? null : Math.round(media),
      median_bucket: durationBucket(media),
      under_1min: num(r.menos_1min) ?? 0,
      under_5min: num(r.menos_5min) ?? 0,
      wins: num(r.ganadas) ?? 0,
      losses: num(r.perdidas) ?? 0,
      gross_profit: round2(num(r.bruto_ganado) ?? 0),
      gross_loss: round2(num(r.bruto_perdido) ?? 0),
      // La unidad viaja con el dato por lo mismo que en todo el módulo: en
      // cuentas Cent estos importes están en centavos.
      unit: unitOf(family),
      synced_at: now,
    };
  });

  for (const part of chunk(payload, 500)) {
    const { error } = await admin
      .from('mt5_trading_behavior')
      .upsert(part, { onConflict: 'company_id,login' });
    if (error) throw new Error(`mt5_trading_behavior: ${error.message}`);
  }

  return {
    loginsRequested: logins.length,
    loginsAnalyzed: acotado.length,
    rows: payload.length,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
