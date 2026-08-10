// ─────────────────────────────────────────────────────────────────────────────
// Ficha de cliente — contrato compartido.
//
// Los clientes NO son una tabla: son el campo `client` de las líneas de
// ingreso. Y es a propósito. Una tabla de clientes obligaría a darlos de alta
// antes de poder facturar, y a mantener sincronizado un catálogo con el texto
// que la gente igual escribe a mano — el modo de falla número uno de este
// repo. Acá el cliente existe porque se le facturó algo, que es la única
// definición que importa para la contabilidad.
//
// El nombre se normaliza para agrupar ("Vex Pro", "vex pro" y " Vex Pro " son
// el mismo cliente) pero se MUESTRA con la grafía más reciente: si alguien
// corrige el nombre, la ficha lo refleja sin perder el histórico.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

import type { IncomeLine } from './income-lines';
import { round2 } from './utils';

/** Una línea de ingreso con el período al que pertenece. */
export interface ClientLine {
  concept: string;
  amount: number;
  received: number;
  pending: number;
  periodId: string;
  periodLabel: string;
  /** Orden cronológico del período (year * 12 + month). */
  periodOrder: number;
}

export interface ClientMonth {
  periodId: string;
  periodLabel: string;
  periodOrder: number;
  amount: number;
  received: number;
  pending: number;
  lines: ClientLine[];
}

export interface ClientCard {
  /** Clave de agrupación: minúsculas y sin espacios de más. */
  key: string;
  /** Nombre tal como se escribió la última vez. */
  name: string;
  amount: number;
  received: number;
  pending: number;
  /** Meses con actividad, del más reciente al más viejo. */
  months: ClientMonth[];
  /** Conceptos distintos facturados, del que más factura al que menos. */
  concepts: Array<{ concept: string; amount: number; times: number }>;
  firstPeriodLabel: string;
  lastPeriodLabel: string;
}

export const UNASSIGNED_CLIENT_KEY = '__unassigned__';

export function clientKey(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.toLowerCase() : UNASSIGNED_CLIENT_KEY;
}

/**
 * Arma la ficha de cada cliente a partir de las líneas de ingreso.
 * `lines` puede venir de varios períodos: se agrupa por cliente y, dentro,
 * por mes.
 */
export function buildClientCards(lines: ClientLine[], clientOf: (index: number) => string | null): ClientCard[] {
  const byClient = new Map<string, { name: string; nameOrder: number; lines: ClientLine[] }>();

  lines.forEach((line, i) => {
    const raw = clientOf(i);
    const key = clientKey(raw);
    const entry = byClient.get(key);
    const display = (raw ?? '').trim();
    if (entry) {
      entry.lines.push(line);
      // Gana la grafía del período más reciente.
      if (display && line.periodOrder >= entry.nameOrder) {
        entry.name = display;
        entry.nameOrder = line.periodOrder;
      }
    } else {
      byClient.set(key, { name: display, nameOrder: line.periodOrder, lines: [line] });
    }
  });

  const cards: ClientCard[] = [];
  for (const [key, entry] of byClient) {
    const monthsMap = new Map<string, ClientMonth>();
    const conceptMap = new Map<string, { concept: string; amount: number; times: number }>();
    let amount = 0, received = 0, pending = 0;

    for (const line of entry.lines) {
      amount += line.amount;
      received += line.received;
      pending += line.pending;

      const month = monthsMap.get(line.periodId);
      if (month) {
        month.amount += line.amount;
        month.received += line.received;
        month.pending += line.pending;
        month.lines.push(line);
      } else {
        monthsMap.set(line.periodId, {
          periodId: line.periodId,
          periodLabel: line.periodLabel,
          periodOrder: line.periodOrder,
          amount: line.amount,
          received: line.received,
          pending: line.pending,
          lines: [line],
        });
      }

      const ck = line.concept.trim().toLowerCase();
      const concept = conceptMap.get(ck);
      if (concept) {
        concept.amount += line.amount;
        concept.times += 1;
      } else {
        conceptMap.set(ck, { concept: line.concept.trim(), amount: line.amount, times: 1 });
      }
    }

    const months = [...monthsMap.values()]
      .map((m) => ({ ...m, amount: round2(m.amount), received: round2(m.received), pending: round2(m.pending) }))
      .sort((a, b) => b.periodOrder - a.periodOrder);

    cards.push({
      key,
      name: entry.name,
      amount: round2(amount),
      received: round2(received),
      pending: round2(pending),
      months,
      concepts: [...conceptMap.values()]
        .map((c) => ({ ...c, amount: round2(c.amount) }))
        .sort((a, b) => b.amount - a.amount),
      firstPeriodLabel: months[months.length - 1]?.periodLabel ?? '',
      lastPeriodLabel: months[0]?.periodLabel ?? '',
    });
  }

  // Quien más debe primero: la ficha se mira para cobrar. A igualdad de
  // deuda, el que más factura.
  return cards.sort((a, b) => (b.pending - a.pending) || (b.amount - a.amount));
}

export interface ClientTotals {
  clients: number;
  amount: number;
  received: number;
  pending: number;
  /** Clientes con algo por cobrar. */
  withDebt: number;
}

export function totalsOf(cards: ClientCard[]): ClientTotals {
  let amount = 0, received = 0, pending = 0, withDebt = 0;
  for (const c of cards) {
    amount += c.amount;
    received += c.received;
    pending += c.pending;
    if (c.pending > 0.009) withDebt += 1;
  }
  return {
    clients: cards.length,
    amount: round2(amount),
    received: round2(received),
    pending: round2(pending),
    withDebt,
  };
}

/** Helper para el caso común: líneas que ya traen su propio `client`. */
export function cardsFromLines(
  lines: Array<IncomeLine & { periodLabel: string; periodOrder: number }>,
): ClientCard[] {
  const mapped: ClientLine[] = lines.map((l) => ({
    concept: l.concept,
    amount: Number(l.amount) || 0,
    received: Number(l.received) || 0,
    pending: Number(l.pending) || 0,
    periodId: l.period_id,
    periodLabel: l.periodLabel,
    periodOrder: l.periodOrder,
  }));
  return buildClientCards(mapped, (i) => lines[i].client);
}
