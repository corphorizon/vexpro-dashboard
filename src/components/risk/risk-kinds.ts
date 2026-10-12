// ─────────────────────────────────────────────────────────────────────────────
// risk-kinds — el mapa «estado de Riesgo → color de badge» del módulo, en UN
// lugar («Libro mayor», docs/diseno-libro-mayor.md §2.1 y §5.5).
//
// POR QUÉ (2026-10-12, migración de Riesgo): cada pantalla del módulo elegía
// el color a ojo, con cuatro mapas locales que ya no coincidían:
//   · /risk/retiros y /risk/retiros/[id] tenían cada uno su `BAND_VARIANT`
//     (copiado, idéntico hoy) y la cola tenía `STATUS_VARIANT`.
//   · `STATUS_VARIANT` preguntaba por `completed`, que NO existe en
//     `crm_withdrawals.status_norm` (migración 088: approved / rejected /
//     cancelled / pending / unknown). Medido leyendo el CHECK: un retiro
//     COMPLETED (status_norm = 'approved') se pintaba GRIS, igual que uno
//     cancelado — el historial no distinguía «salió la plata» de «no salió».
//   · El panel de prop firm tenía `VEREDICTO` con su variante, y la ficha
//     pintaba el riesgo de cuentas con ternarios `bg-negative/10…` inline,
//     tres veces.
// Es el modo de falla número uno del repo (reglas §1.1). Acá vive una vez,
// tipado contra los tipos canónicos: si aparece una banda o un veredicto
// nuevo, `tsc` falla acá en vez de caer al gris.
//
// REGLAS (las de status-kind.ts):
//   ok   = no hay nada que mirar / salió bien   → pos
//   pend = requiere que alguien mire             → pend
//   bad  = rechazado / incumple / riesgo alto    → neg
//   info = paso intermedio sin acción            → info
//   neutral = no afirma nada (desconocido, cancelado por el cliente)
// Un valor desconocido en runtime devuelve `neutral` — nunca `ok`.
//
// DESCARTADO:
//   · Sumar dominios a `components/ui/status-kind.ts`: esta tanda no puede
//     tocar `ui/**` (otros agentes en paralelo). Los mapas están escritos con
//     la misma forma (`Record<Estado, StatusKind>`) para mudarlos tal cual
//     cuando se pueda — queda anotado en el reporte.
//     [2026-10-12, barrido final] HECHO: los mapas viven ahora en
//     STATUS_DOMAINS (riskBand, withdrawalNorm, depositNorm, reviewDecision,
//     riskFactor, riskLevel, riskCheck, propfirmOutcome) y las funciones de
//     acá delegan en `statusKind`. Mismos valores: risk-kinds.test.ts compara
//     cada dominio entero contra la tabla de antes de la mudanza.
//   · Pintar la banda por el score (número): la banda la decide `score.ts`
//     con la calibración vigente; recalcular el corte acá sería una segunda
//     definición de la misma regla.
// ─────────────────────────────────────────────────────────────────────────────

import { statusKind, type StatusKind, type PropfirmOutcome } from '@/components/ui/status-kind';
import type { RiskBand, FactorImpact } from '@/lib/withdrawal-risk/score';
import type { AccountRisk } from '@/lib/risk/account-review';
import type { NivelToxico } from '@/lib/risk/broker-toxicity';

export type { PropfirmOutcome };

/** Banda de RIESGO del score (alta banda = score bajo). */
export function bandKind(band: RiskBand | null | undefined): StatusKind {
  return statusKind('riskBand', band);
}

/**
 * `crm_withdrawals.status_norm` (CHECK de la migración 088). `approved` es
 * COMPLETED: la plata salió.
 */
export function withdrawalStatusKind(norm: string | null | undefined): StatusKind {
  return statusKind('withdrawalNorm', norm);
}

/** `crm_deposits.status_norm` (CHECK de la migración 088). */
export function depositStatusKind(norm: string | null | undefined): StatusKind {
  return statusKind('depositNorm', norm);
}

/** Decisión registrada por el equipo (withdrawal_reviews.decision). */
export function decisionKind(decision: string | null | undefined): StatusKind {
  return statusKind('reviewDecision', decision);
}

/** Severidad de un factor del score: 'down' empuja a rechazar. */
export function factorKind(impact: FactorImpact): StatusKind {
  return statusKind('riskFactor', impact);
}

/** Riesgo operativo de una cuenta (account-review) y toxicidad para el bróker. */
export function levelKind(level: AccountRisk | NivelToxico | null | undefined): StatusKind {
  return statusKind('riskLevel', level);
}

/**
 * Estado de una regla/señal. «Sin comprobar» NO es cumplida: va en `pend`
 * (alguien tiene que mirarla), nunca en verde.
 */
export function checkKind(status: string | null | undefined): StatusKind {
  return statusKind('riskCheck', status);
}

/** Veredicto del REGLAMENTO de prop firm (no una decisión de nadie). */
export function outcomeKind(outcome: string | null | undefined): StatusKind {
  return statusKind('propfirmOutcome', outcome);
}

/**
 * Nivel de margen MT5 (en %). < 100 ya no cubre su margen (crítico); entre
 * 100 y 200 se vigila (los mismos cortes que `risk-query.ts`, que es quien
 * arma las listas — acá sólo se pinta la lista en la que vino la fila).
 */
export function marginKind(list: 'critical' | 'watch'): StatusKind {
  return list === 'critical' ? 'bad' : 'pend';
}
