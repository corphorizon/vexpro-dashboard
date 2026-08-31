// ─────────────────────────────────────────────────────────────────────────────
// Asiento diario automático del libro por canal (server-only).
//
// Lo llama el cron de las 00:00 UTC, justo después de guardar el snapshot del
// día. En ese momento tenemos las dos puntas necesarias:
//   · el saldo REAL que reportó la API al cierre de ayer (el snapshot), y
//   · las transacciones de ayer ya sincronizadas en api_transactions.
//
// Con eso se asientan hasta 4 líneas por canal y por día:
//   · Depósitos del día        (ingreso)
//   · Retiros del día          (egreso)  — sin transferencias internas
//   · Transferencias internas  (egreso)  — mueven saldo, no son retiro del negocio
//   · Ajuste de conciliación   (el resto) — fuerza el cierre contra el saldo real
//
// Y una quinta, excepcional:
//   · Regularización de N días — cuando el cron no pudo asentar durante varios
//     días y el residuo acumulado ya no es «el ajuste de hoy». Ver
//     RECOVERY_AFTER_DAYS más abajo: el guard NO puede convertir un día
//     anómalo en un congelamiento permanente (Coinsbuy, 10 días, $91.756,14).
//
// La última línea es la que hace que el libro NUNCA discrepe de la wallet.
// En Coinsbuy absorbe las comisiones de red (~$1-4/día); en UniPayment, las
// liquidaciones de salida que su API no expone. Verificado contra 6 días de
// producción: con estas 4 líneas el cierre da exacto al centavo.
//
// CANALES SIN FUENTE DE MOVIMIENTOS (`opts.noMovementFeed`, 2026-08-31)
// FairPay entró al libro automático sin tener de dónde sacar los movimientos
// del día: su saldo viene de banking.fairpay.online, que no expone extracto, y
// las filas de `api_transactions.provider='fairpay'` son cobros del PORTAL,
// otro sistema (ver src/lib/channel-ledger.ts). Para esos canales el día se
// asienta con UNA sola línea —la variación del saldo real— y la nota lo dice
// con todas las letras, en vez de dejar creer que hubo depósitos que nadie
// midió. El caudal de la línea es correcto; lo que no sabemos es su desglose,
// y eso se escribe, no se disimula.
// ─────────────────────────────────────────────────────────────────────────────

import type { createAdminClient } from '@/lib/supabase/admin';
import { AUTO_CATEGORIES, previousDay, resolveInternalTransfers } from '@/lib/channel-ledger';
import { API_CHANNELS } from '@/lib/api-channels';

type Admin = ReturnType<typeof createAdminClient>;

interface DayMovements {
  deposits: number;
  withdrawals: number;
  internal: number;
}

interface LedgerLine {
  entry_date: string;
  kind: 'in' | 'out';
  concept: string;
  category: string;
  amount: number;
  notes?: string;
}

/** Diferencias por debajo de un centavo son ruido de coma flotante, no un ajuste. */
const CENT = 0.01;

/**
 * Ajuste máximo tolerado por canal antes de ABORTAR el asiento del día.
 *
 * Un ajuste fuera de rango casi siempre es una wallet que faltó en la
 * respuesta de la API o un snapshot pisado: mejor no escribir nada, avisar,
 * y reprocesar el día cuando se entienda la causa.
 *
 * ── COINSBUY: 500 → 150.000 (2026-08-31, auditoría de finanzas) ────────────
 * El 500 se escribió cuando el ajuste de Coinsbuy era la comisión de red de UNA
 * wallet: $1-4/día. Desde entonces el canal agrega CUATRO wallets fijadas
 * (migración 084: el snapshot es el saldo de la empresa, operativas e internas)
 * y entre ellas se mueven internas de $5.000 a $50.000 por día. El comentario
 * viejo —«comisiones de red, $1-4/día, 500 da margen de sobra»— dejó de ser
 * cierto sin que nadie lo tocara, que es el modo de falla que §5.2.4 pide
 * confesar en el mismo lugar en vez de borrar. Era falso; acá está el dato.
 *
 * MEDICIÓN (21/08 → 31/08, ajustes reales que el guard rechazó):
 *   · rango de residuos:      ±6.700 … ±103.962
 *   · primer rechazo (21/08): −8.478,29  contra un tope de 500
 *   · consecuencia:           11 avisos `ledger.not_posted`, CERO recuperación
 *   · libro congelado en 244.079,51 contra 335.835,65 reales ⇒ brecha 91.756,14
 *     que se arrastró 10 días a la vista de todo el dashboard.
 * 150.000 deja pasar el peor residuo medido con ~45% de margen y sigue siendo
 * menos de la mitad del saldo del canal: un día que mueva más de $150.000 sobre
 * $335.835 no es una comisión de red, es un dato roto y lo mira una persona.
 *
 * UniPayment: absorbe las liquidaciones de salida que su API no expone
 * ($2K-8K/día observados) — 25.000 cubre picos sin tragarse un desastre.
 *
 * Pay-Pros: los movimientos llegan por webhook y el balance por getBalance,
 * pero el webhook NO informa la comisión de Pay-Pros ni retenciones/liquidaciones
 * que ellos hagan de su lado — todo eso cae en el ajuste. Arranca en 5.000
 * como umbral conservador hasta ver los primeros días reales; si el ajuste
 * típico resulta mayor, subirlo con dato en la mano, no a ciegas. (Al
 * 2026-08-31 hay 15 asientos 'api' de Pay-Pros y ninguno abortó por tope.)
 *
 * FairPay: caso EXTREMO y por eso el tope más alto. Su libro NO tiene fuente de
 * movimientos —el banking no expone extracto y las filas del portal de cobros
 * son otro sistema (ver channel-ledger.ts)—, así que la variación del saldo
 * ENTERA cae en el ajuste, siempre. No es ruido: es el movimiento real, y es lo
 * único que sabemos de él. Observado en agosto 2026: dos saltos, +6.747,05
 * (18/08) y +416,42 (25/08). 25.000 deja pasar una liquidación grande y sigue
 * frenando un desastre.
 *
 * ⚠ EL NÚMERO NO ES EL ARREGLO. Subir el tope evita ESTE congelamiento, no el
 * próximo. Lo que lo evita es que el guard deje de ser una puerta de una sola
 * dirección: ver `RECOVERY_AFTER_DAYS` más abajo.
 *
 * ── DERIVADO, NO ESCRITO A MANO (2026-08-31, auditoría de finanzas, ítem 14) ─
 * Hasta hoy esto era un `Record` literal, la QUINTA lista por canal del repo.
 * Un built-in `auto` nuevo no aparecía acá y caía al `DEFAULT_MAX_ADJUSTMENT`
 * de 1.000 sin que nadie lo decidiera: su libro se congelaba la primera noche
 * que se moviera más de mil dólares, exactamente como Coinsbuy con su tope de
 * 500. Los números NO cambiaron —son los mismos cuatro— pero ahora viven en
 * `src/lib/api-channels.ts` junto al resto de lo que se sabe del canal, y
 * `apiChannelRegistryDrift()` (con su test) hace que agregar un canal sin tope
 * rompa la build en vez de romper el libro.
 */
export const MAX_ADJUSTMENT: Record<string, number> = Object.fromEntries(
  API_CHANNELS.map((c) => [c.key, c.maxAdjustment]),
);

/**
 * Tope por defecto para un canal sin entrada propia.
 *
 * Sigue existiendo para las ubicaciones que NO son built-in (un `custom_*` sin
 * direcciones on-chain), no como red para un canal automático olvidado: eso lo
 * cubre el registro.
 */
export const DEFAULT_MAX_ADJUSTMENT = 1_000;

/**
 * Tope para una ubicación ON-CHAIN (migración 085).
 *
 * Una wallet on-chain no tiene "clave conocida": su canal es `wallet_externa` o
 * un `custom_<uuid>`, así que el tope no puede vivir en el Record de arriba —
 * de ahí `maxAdjustmentFor`.
 *
 * POR QUÉ TAN ALTO. En esta wallet el ajuste NO es ruido, es movimiento real
 * todavía sin explicar:
 *   · Las transferencias USDT de Tron SÍ se explican (llegan por
 *     api_transactions y la RPC del libro las separa en depósitos/retiros).
 *   · BSC y Ethereum, mientras no haya API key de explorador, aportan solo su
 *     saldo: lo que se mueva ahí cae entero en el ajuste.
 *   · El GAS se consume en cada transacción y su precio se mueve solo: el total
 *     del canal sube y baja sin que haya ninguna transferencia. Eso también
 *     cae en el ajuste, y está BIEN — es la diferencia real del día.
 *   · El primer día después del alta, el ajuste absorbe la brecha entre el
 *     último saldo cargado a mano y la cadena (Vex Pro: 17.613 manual vs
 *     ~17.116 reales ⇒ ajuste ≈ −497).
 * 50.000 deja pasar todo eso y sigue frenando un desastre (una wallet de $17K
 * no puede moverse $50K en un día sin que alguien mire).
 */
export const ONCHAIN_MAX_ADJUSTMENT = 50_000;

/**
 * Tope de ajuste del canal. Los canales built-in lo tienen por clave; una
 * ubicación on-chain lo tiene por su NATURALEZA, que el caller conoce y la
 * clave no. Es la forma más simple de tener un tope dinámico sin inventar una
 * tabla de configuración ni parsear la clave.
 */
export function maxAdjustmentFor(
  channelKey: string,
  opts: { onchain?: boolean } = {},
): number {
  const byKey = MAX_ADJUSTMENT[channelKey];
  if (byKey !== undefined) return byKey;
  return opts.onchain ? ONCHAIN_MAX_ADJUSTMENT : DEFAULT_MAX_ADJUSTMENT;
}

/**
 * ─── EL GUARD NO PUEDE SER UNA PUERTA DE UNA SOLA DIRECCIÓN ──────────────────
 * (2026-08-31, auditoría de finanzas)
 *
 * El guard de arriba abortaba el día y no dejaba NINGÚN estado. Como el asiento
 * no se escribía, la noche siguiente el saldo previo seguía siendo el del
 * último día asentado, así que el ajuste calculado incluía todo lo acumulado y
 * volvía a superar el tope. Un día anómalo se convertía en un congelamiento
 * PERMANENTE: Coinsbuy abortó el 21/08 por −8.478,29 y a partir de ahí comparó
 * cada noche contra el saldo del 20/08. Diez días, once avisos, cero
 * recuperación, y $91.756,14 de brecha a la vista en /balances.
 *
 * Dos piezas arreglan el mecanismo:
 *
 * 1) EL TOPE SE ESCALA CON LOS DÍAS QUE CUBRE. Comparar un residuo de seis días
 *    contra una tolerancia de UN día es comparar cosas distintas, y es lo que
 *    hacía que la brecha nunca pudiera cerrarse sola. `effectiveMax =
 *    maxAdj × díasCubiertos`.
 *
 * 2) DESPUÉS DE `RECOVERY_AFTER_DAYS` DÍAS SIN ASENTAR, SE ASIENTA IGUAL, pero
 *    con categoría propia (`regularization`), concepto que dice cuántos días
 *    cubre, nota con las fechas exactas, y aviso CRÍTICO. Un libro congelado
 *    miente todos los días y no avisa a nadie más que a Sentry; una línea de
 *    regularización bien rotulada dice la verdad y pide revisión. Entre las dos
 *    formas de estar mal, se elige la que se ve.
 *
 * Se descartaron dos alternativas:
 *   · «Reabrir sin tope si el ajuste es igual al de ayer»: frágil y sin
 *     significado contable.
 *   · «Asentar una línea por cada día perdido desde el cron»: es lo CORRECTO,
 *     pero el cron solo conoce el saldo real de un día. Reconstruir día por día
 *     exige leer los snapshots de cada fecha, que es exactamente lo que hace
 *     `scripts/backfill-channel-ledger.ts` — la remediación preferida, a mano y
 *     con alguien mirando. La regularización automática es la red de seguridad
 *     para que el libro no se quede congelado mientras tanto, no su reemplazo.
 *
 * 3 días: dos noches de margen para que una persona mire un día anómalo antes
 * de que el sistema se destrabe solo. Con 1 no habría guard; con 7 la brecha
 * vive una semana en pantalla, que es lo que acaba de pasar.
 */
export const RECOVERY_AFTER_DAYS = 3;

export interface LedgerSyncResult {
  channel_key: string;
  entry_date: string;
  /** Saldo real de la API al cierre del día — el libro cierra acá. */
  closing: number;
  bootstrapped?: boolean;
  adjustment?: number;
  /**
   * Cuántos días REALES cubre el asiento. 1 = normal. >1 = el libro venía
   * congelado y esta línea regulariza el tramo; nunca se presenta como el
   * movimiento de un solo día.
   */
  daysCovered?: number;
  /** Se asentó por encima del tope para destrabar el libro. Pide revisión. */
  forced?: boolean;
  error?: string;
}

/** Días calendario entre dos fechas ISO (b − a). Sin zona horaria local. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** YYYY-MM-DD del día siguiente. Espejo de `previousDay`. */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Asienta el día `entryDate` del canal `channelKey` y deja el libro cerrando
 * exactamente en `actualClose` (el saldo que reportó la API).
 *
 * Idempotente: el índice único parcial (company, canal, fecha, categoría)
 * sobre source='api' hace que un segundo pase del cron sobreescriba las
 * líneas en vez de duplicarlas.
 */
export async function syncChannelLedgerDay(
  admin: Admin,
  companyId: string,
  channelKey: string,
  entryDate: string,
  actualClose: number,
  opts: { onchain?: boolean; noMovementFeed?: boolean } = {},
): Promise<LedgerSyncResult> {
  // ── Saldo con el que veníamos ──────────────────────────────────────────
  const { data: priorRows, error: priorError } = await admin.rpc('get_channel_ledger_balances', {
    p_company_id: companyId,
    p_asof: previousDay(entryDate),
  });
  if (priorError) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: priorError.message };
  }

  const prior = (priorRows ?? []) as Array<{ channel_key: string; balance: number | string }>;
  const priorRow = prior.find((r) => r.channel_key === channelKey);

  // ── Arranque en frío ───────────────────────────────────────────────────
  // Sin saldo previo no hay contra qué conciliar: inventar movimientos sería
  // fabricar historia. Se abre el libro con el saldo real de hoy y a partir
  // de mañana el asiento diario ya es normal.
  if (!priorRow) {
    const { error } = await admin.from('channel_ledger_entries').insert({
      company_id: companyId,
      channel_key: channelKey,
      entry_date: entryDate,
      kind: 'opening',
      source: 'api',
      concept: 'Saldo inicial',
      category: AUTO_CATEGORIES.opening,
      amount: actualClose,
      notes: 'Apertura automática del libro con el saldo reportado por la API.',
    });
    // 23505 = otro pase del cron lo abrió primero. No es un error.
    if (error && error.code !== '23505') {
      return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: error.message };
    }
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, bootstrapped: true };
  }

  const priorBalance = Number(priorRow.balance) || 0;

  // ── ¿Veníamos al día, o el libro está congelado? ───────────────────────
  // El último asiento 'api' anterior a hoy dice hasta dónde llegó el cron. Si
  // no es ayer, hay un hueco y el residuo de hoy NO es el movimiento de hoy:
  // son todos los días que no se asentaron. Sin esta pregunta, el asiento sale
  // fechado hoy con el importe de N días — el caso UniPayment del 2026-08:
  // −21.740,51 que eran seis días, asentados como si fueran uno.
  const { data: lastRows, error: lastErr } = await admin
    .from('channel_ledger_entries')
    .select('entry_date')
    .eq('company_id', companyId)
    .eq('channel_key', channelKey)
    .eq('source', 'api')
    .lt('entry_date', entryDate)
    .order('entry_date', { ascending: false })
    .limit(1);
  if (lastErr) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: lastErr.message };
  }
  const lastPosted = (lastRows ?? [])[0]?.entry_date as string | undefined;

  // Días que cubre el asiento de hoy: 1 si el cron venía al día. Sin asiento
  // 'api' previo (libro solo con líneas manuales) no se puede medir el hueco:
  // se asume 1 antes que inventar una regularización de largo desconocido.
  const daysCovered = lastPosted ? Math.max(1, daysBetween(lastPosted, entryDate)) : 1;
  const isCatchUp = daysCovered > 1;
  const firstMissingDay = isCatchUp && lastPosted ? nextDay(lastPosted) : entryDate;

  // ── Movimientos del día ────────────────────────────────────────────────
  const { data: movRows, error: movError } = await admin.rpc('get_channel_day_movements', {
    p_company_id: companyId,
    p_day: entryDate,
  });
  if (movError) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: movError.message };
  }

  const mov = ((movRows ?? []) as Array<{ channel_key: string } & Record<string, number | string>>)
    .find((r) => r.channel_key === channelKey);

  const day: DayMovements = {
    deposits: Number(mov?.deposits) || 0,
    withdrawals: Number(mov?.withdrawals) || 0,
    internal: Number(mov?.internal) || 0,
  };

  // Líneas MANUALES del mismo día: entran al saldo (balanceAsOf las incluye)
  // pero no vienen de api_transactions, así que si no se suman acá el ajuste
  // las "des-explicaría". Caso concreto: el alta de la wallet 1705 se asentó
  // como línea manual de +38.397,58 el 2026-08-06 — sin este término, el
  // cierre de esa noche calcularía un ajuste de ~+38K y abortaría por umbral.
  const { data: manualRows, error: manualErr } = await admin
    .from('channel_ledger_entries')
    .select('kind, amount')
    .eq('company_id', companyId)
    .eq('channel_key', channelKey)
    .eq('entry_date', entryDate)
    .eq('source', 'manual');
  if (manualErr) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: manualErr.message };
  }
  const manualDelta = ((manualRows ?? []) as Array<{ kind: string; amount: number }>)
    .reduce((sum, r) => sum + (r.kind === 'out' ? -Number(r.amount) : Number(r.amount)), 0);

  const lines: LedgerLine[] = [];
  if (day.deposits > CENT) {
    lines.push({ entry_date: entryDate, kind: 'in', concept: 'Depósitos del día', category: AUTO_CATEGORIES.deposits, amount: day.deposits });
  }
  if (day.withdrawals > CENT) {
    lines.push({ entry_date: entryDate, kind: 'out', concept: 'Retiros del día', category: AUTO_CATEGORIES.withdrawals, amount: day.withdrawals });
  }

  // ── Internas + ajuste: decide el saldo real del custodio ───────────────
  // Una interna entre dos wallets FIJADAS no mueve el agregado: asentarla
  // como salida y revertirla con un ajuste gigante era ficción contable (el
  // 06/08 el guard abortó el día entero por $35.000 que fueron 1079→1705).
  // resolveInternalTransfers contrasta los dos candidatos contra actualClose.
  const baseWithoutInternal = priorBalance + manualDelta + day.deposits - day.withdrawals;
  const { internalLeftAggregate, adjustment } = resolveInternalTransfers({
    baseWithoutInternal,
    internal: day.internal,
    actualClose,
  });

  if (day.internal > CENT && internalLeftAggregate) {
    lines.push({
      entry_date: entryDate, kind: 'out', concept: 'Transferencias internas',
      category: AUTO_CATEGORIES.internal, amount: day.internal,
      notes: 'Movimiento hacia una wallet propia fuera del agregado: mueve el saldo del canal pero queda fuera de Retiros Totales.',
    });
  }
  if (Math.abs(adjustment) > CENT) {
    // Un residuo que cubre varios días NO se etiqueta como el ajuste de hoy.
    // Es el bug de UniPayment: −21.740,51 de seis días asentados como uno,
    // con el nombre de una comisión. El libro cuadraba y contaba una mentira.
    const baseNote = opts.noMovementFeed
      ? 'Variación del saldo real informado por la API. Este canal no tiene extracto: el proveedor no expone los movimientos, así que se conoce cuánto se movió pero no su desglose en depósitos y retiros.'
      : opts.onchain
        ? 'Diferencia contra el saldo real de la cadena: fees de gas consumidos, variación del precio del gas y transferencias de redes sin historial disponible (BEP20/ERC20 sin API key de explorador).'
        : 'Diferencia contra el saldo real de la API (comisiones de red y movimientos no detallados por el proveedor).';

    lines.push({
      entry_date: entryDate,
      kind: adjustment >= 0 ? 'in' : 'out',
      concept: isCatchUp
        ? `Regularización de ${daysCovered} días (${firstMissingDay} → ${entryDate})`
        : opts.noMovementFeed
          ? 'Variación del saldo'
          : 'Ajuste de conciliación',
      category: isCatchUp
        ? AUTO_CATEGORIES.regularization
        : opts.noMovementFeed
          ? AUTO_CATEGORIES.balanceDelta
          : AUTO_CATEGORIES.adjustment,
      amount: Math.abs(adjustment),
      notes: isCatchUp
        ? `El libro no se asentó entre el ${firstMissingDay} y el ${previousDay(entryDate)}: ` +
          `este importe acumula ${daysCovered} días (${firstMissingDay} → ${entryDate}) y NO es el ` +
          `movimiento del ${entryDate}. Los depósitos y retiros de los días perdidos también están ` +
          `acá dentro, sin desglosar. Para reconstruirlo día por día: ` +
          `scripts/backfill-channel-ledger.ts ${channelKey} --from ${firstMissingDay}. ${baseNote}`
        : baseNote,
    });
  }

  // ── Cota de sanidad ANTES de escribir ──────────────────────────────────
  // Un ajuste enorme no es una comisión de red, es un dato de entrada roto
  // (wallet ausente en la respuesta, snapshot pisado, wallet recién fijada).
  // Escribirlo contaminaría el libro con un movimiento que no existió.
  //
  // Pero abortar y ya es lo que congeló Coinsbuy diez días: ver
  // RECOVERY_AFTER_DAYS. El tope se compara contra los días que el asiento
  // cubre de verdad, y pasados N días sin asentar se escribe igual, rotulado y
  // con aviso, porque un libro congelado también miente — y encima en silencio.
  const maxAdj = maxAdjustmentFor(channelKey, opts);
  const effectiveMax = maxAdj * daysCovered;
  const forced = Math.abs(adjustment) > effectiveMax && daysCovered >= RECOVERY_AFTER_DAYS;

  if (Math.abs(adjustment) > effectiveMax && !forced) {
    return {
      channel_key: channelKey,
      entry_date: entryDate,
      closing: actualClose,
      daysCovered,
      error:
        `Ajuste fuera de rango (${adjustment.toFixed(2)} > ±${effectiveMax}` +
        (daysCovered > 1 ? ` = ${maxAdj} × ${daysCovered} días` : '') +
        `): no se asentó el día. Revisar snapshot y wallets. ` +
        `Si no se resuelve, en ${RECOVERY_AFTER_DAYS - daysCovered} noche(s) más el libro se destraba ` +
        `solo con una línea de regularización rotulada.`,
    };
  }

  // RPC en vez de upsert: el ON CONFLICT de PostgREST no puede apoyarse en el
  // índice único PARCIAL (where source='api') — Postgres lo rechaza con 42P10
  // y por eso el cron nunca escribió (auditoría 2026-08-06). La RPC además
  // REEMPLAZA el día completo (delete+insert de las líneas 'api'), así que una
  // re-corrida que produce menos líneas no deja huérfanas.
  const { error } = await admin.rpc('replace_channel_ledger_day', {
    p_company_id: companyId,
    p_channel_key: channelKey,
    p_entry_date: entryDate,
    p_lines: lines.map((l) => ({ ...l, notes: l.notes ?? null })),
  });
  if (error) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: error.message };
  }

  return {
    channel_key: channelKey,
    entry_date: entryDate,
    closing: actualClose,
    adjustment,
    daysCovered,
    ...(forced ? { forced: true } : {}),
  };
}
