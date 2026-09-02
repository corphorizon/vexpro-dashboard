// ─────────────────────────────────────────────────────────────────────────────
// Los avisos del hedge fund — la DECISIÓN, en funciones puras.
//
// Cuatro de los cinco avisos del módulo no tienen evento: nacen del PASO DEL
// TIEMPO, igual que «orden aprobada sin pagar» y «período sin cerrar». Los
// emite el barrido diario (`/api/cron/notification-sweep`); acá vive lo que
// decide SI hay que avisar, para poder testearlo sin base y sin cron. El
// quinto —el cambio de configuración de comisiones— sí tiene evento y lo emite
// el vigilante dentro del sync.
//
// Los tipos viven en el catálogo único (`notifications/catalog.ts`). Acá NO se
// declara ninguna segunda lista de claves: se importan y se usan.
// ─────────────────────────────────────────────────────────────────────────────

import { monthKeyUtc } from './aggregate';
import type { HfFundRow, HfInvestmentRow, HfPayoutRow, HfWithdrawalRequestRow } from './types';

/** Días de antelación del aviso de vencimiento. */
export const HF_MATURITY_ALERT_DAYS = 30;

/**
 * Estados FINALES de una inversión: ya no espera decisión de nadie.
 *
 * Se listan los finales y NO los pendientes a propósito. Si el CRM inventa un
 * estado nuevo, con esta lista cae del lado de «todavía abierto» y APARECE en
 * el aviso; con la lista al revés desaparecería en silencio, que es
 * exactamente cómo `REVIEWED` dejó 8 retiros fuera de la cola en agosto.
 */
export const HF_FINAL_INVESTMENT_STATUSES: readonly string[] = [
  'REJECTED',
  'TERMINATED',
  'CLOSED',
  'CANCELLED',
  'CANCELED', // el CRM ya escribió este typo 6 veces en `withdrawals`.
];

/**
 * Estados de una solicitud de retiro que ya se resolvieron.
 *
 * `hedgefundwithdrawalrequests` está VACÍA en las dos empresas al 2026-09-02,
 * así que este vocabulario NO está verificado contra datos reales: sale del
 * que usan las otras colecciones del mismo CRM. Por eso la lista es de
 * RESUELTOS y no de pendientes — un estado que no conocemos cuenta como
 * pendiente y se ve, que es el error que se puede corregir mirando la pantalla.
 */
export const HF_RESOLVED_REQUEST_STATUSES: readonly string[] = [
  'COMPLETED',
  'PROCESSED',
  'REJECTED',
  'CANCELLED',
  'CANCELED',
];

/**
 * Desde cuándo tiene sentido preguntar «¿este fondo pagó rendimiento este mes?».
 * Kevin, 2026-09-02: los primeros rendimientos se pagan en septiembre de 2026.
 * Antes de esa fecha el aviso sería un falso positivo mensual.
 */
export const HF_PAYOUT_ALERT_FROM_YM = '2026-09';

export interface HedgeFundAlert {
  /** Clave del catálogo único (notifications/catalog.ts). */
  type:
    | 'hedge_fund.maturing_soon'
    | 'hedge_fund.pending_approval'
    | 'hedge_fund.withdrawal_pending'
    | 'hedge_fund.no_payout_this_month';
  params: Record<string, string | number>;
  /** Sufijo del dedupe, para que dos avisos distintos no se pisen. */
  dedupeSuffix: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function isFinalStatus(status: string | null): boolean {
  return status !== null && HF_FINAL_INVESTMENT_STATUSES.includes(status);
}

/**
 * Decide qué hay que avisar hoy. Las filas que entran acá TIENEN que venir ya
 * filtradas de datos de prueba: un aviso por el vencimiento del fondo `qa-tst`
 * es la forma más rápida de que el equipo deje de leer los avisos.
 */
export function buildHedgeFundAlerts(input: {
  funds: readonly HfFundRow[];
  investments: readonly HfInvestmentRow[];
  payouts: readonly HfPayoutRow[];
  withdrawalRequests: readonly HfWithdrawalRequestRow[];
  now?: Date;
}): HedgeFundAlert[] {
  const now = input.now ?? new Date();
  const alertas: HedgeFundAlert[] = [];
  const activas = input.investments.filter((i) => i.status === 'ACTIVE');

  // ── 1. Capital que vence en ≤ 30 días ──────────────────────────────────
  // Las YA VENCIDAS entran también: una inversión con vencimiento pasado y
  // todavía ACTIVE es más urgente que una que vence mañana, y dejarla afuera
  // por «ya pasó» la haría desaparecer justo cuando importa.
  const limite = now.getTime() + HF_MATURITY_ALERT_DAYS * 86_400_000;
  const porVencer = activas.filter((i) => {
    if (!i.end_date) return false;
    const t = Date.parse(i.end_date);
    return Number.isFinite(t) && t <= limite;
  });
  if (porVencer.length > 0) {
    alertas.push({
      type: 'hedge_fund.maturing_soon',
      params: {
        count: porVencer.length,
        amount: round2(porVencer.reduce((s, i) => s + (i.principal ?? i.balance ?? 0), 0)).toFixed(2),
        days: HF_MATURITY_ALERT_DAYS,
      },
      dedupeSuffix: 'maturing',
    });
  }

  // ── 2. Inversiones esperando aprobación MANUAL ─────────────────────────
  // El dashboard NO aprueba: la aprobación se hace en el CRM. Esto es el aviso
  // de que hay plata de un cliente esperando que una persona decida — la misma
  // separación que la cola de retiros (§4.3).
  const manuales = new Set(
    input.funds.filter((f) => f.approval_mode === 'MANUAL').map((f) => f.fund_key),
  );
  const sinAprobar = input.investments.filter(
    (i) =>
      !!i.fund_key &&
      manuales.has(i.fund_key) &&
      i.approved_at === null &&
      !isFinalStatus(i.status),
  );
  if (sinAprobar.length > 0) {
    alertas.push({
      type: 'hedge_fund.pending_approval',
      params: {
        count: sinAprobar.length,
        amount: round2(
          sinAprobar.reduce((s, i) => s + (i.invested ?? i.principal ?? 0), 0),
        ).toFixed(2),
      },
      dedupeSuffix: 'approval',
    });
  }

  // ── 3. Solicitudes de retiro sin resolver ──────────────────────────────
  const pendientes = input.withdrawalRequests.filter(
    (w) => !(w.status !== null && HF_RESOLVED_REQUEST_STATUSES.includes(w.status)),
  );
  if (pendientes.length > 0) {
    alertas.push({
      type: 'hedge_fund.withdrawal_pending',
      params: { count: pendientes.length },
      dedupeSuffix: 'withdrawals',
    });
  }

  // ── 4. Fondo con capital activo y SIN pago este mes ────────────────────
  // El aviso del silencio: cuando una corrida de pago no corre, no falla nada,
  // no hay error en ningún log, y lo único que pasa es que los clientes no
  // cobran. Sólo desde septiembre de 2026 (ver HF_PAYOUT_ALERT_FROM_YM).
  const mes = now.toISOString().slice(0, 7);
  if (mes >= HF_PAYOUT_ALERT_FROM_YM) {
    const conPagoEsteMes = new Set(
      input.payouts
        .filter((p) => {
          const fecha = p.finished_at ?? p.started_at ?? p.source_created_at;
          return !!fecha && monthKeyUtc(fecha) === mes;
        })
        .map((p) => p.fund_key)
        .filter((v): v is string => !!v),
    );
    const conCapital = new Set(
      activas.map((i) => i.fund_key).filter((v): v is string => !!v),
    );
    const sinPago = [...conCapital].filter((k) => !conPagoEsteMes.has(k)).sort();
    if (sinPago.length > 0) {
      alertas.push({
        type: 'hedge_fund.no_payout_this_month',
        params: { funds: sinPago.length, month: mes },
        // El mes va en el dedupe: el aviso de septiembre no puede silenciar al
        // de octubre.
        dedupeSuffix: `nopayout:${mes}`,
      });
    }
  }

  return alertas;
}
