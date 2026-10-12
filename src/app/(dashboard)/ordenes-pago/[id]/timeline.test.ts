// Línea de tiempo de una orden de pago: orden cronológico real, actores (sin
// inventar), tonos = los del badge (registro único) y pasos que faltan.
import { describe, expect, it } from 'vitest';
import { statusKind } from '@/components/ui/status-kind';
import { TRANSITIONS, type PaymentOrder, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import { buildTimeline, upcomingSteps } from './timeline';

function order(p: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    id: 'o1',
    order_number: 'OP-2026-0001',
    status: 'draft',
    created_by: 'u-ana',
    created_by_name: 'Ana',
    created_at: '2026-10-01T10:00:00Z',
    submitted_at: null,
    approved_by: null,
    approved_by_name: null,
    approved_at: null,
    rejected_by: null,
    rejected_by_name: null,
    rejected_at: null,
    rejection_reason: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    payment_reference: null,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancellation_reason: null,
    expense_id: null,
    ...p,
  } as PaymentOrder;
}

describe('buildTimeline — camino feliz', () => {
  const paid = order({
    status: 'paid',
    submitted_at: '2026-10-02T09:00:00Z',
    approved_by: 'u-kevin',
    approved_by_name: 'Kevin',
    approved_at: '2026-10-03T11:00:00Z',
    paid_by_name: 'Sofía',
    paid_at: '2026-10-04T16:30:00Z',
    payment_reference: '0xabc',
    expense_id: 'e1',
  });

  it('creada → enviada → aprobada → pagada → egreso, con quién y cuándo', () => {
    const tl = buildTimeline(paid);
    expect(tl.map((e) => e.kind)).toEqual(['created', 'submitted', 'approved', 'paid', 'expense']);
    expect(tl.map((e) => e.actor)).toEqual(['Ana', null, 'Kevin', 'Sofía', null]);
    expect(tl[3]).toMatchObject({ at: '2026-10-04T16:30:00Z', reference: '0xabc' });
  });

  it('«enviada» no tiene actor: la tabla no guarda submitted_by y no se supone el creador', () => {
    expect(buildTimeline(paid).find((e) => e.kind === 'submitted')?.actor).toBeNull();
  });

  it('tonos = los del badge (statusKind): enviada pend, aprobada y pagada ok, creada neutral', () => {
    const tone = Object.fromEntries(buildTimeline(paid).map((e) => [e.kind, e.tone]));
    expect(tone.created).toBe('neutral');
    expect(tone.submitted).toBe(statusKind('paymentOrder', 'pending'));
    expect(tone.approved).toBe(statusKind('paymentOrder', 'approved'));
    expect(tone.paid).toBe(statusKind('paymentOrder', 'paid'));
  });
});

describe('buildTimeline — rechazada y anulada en neg', () => {
  it('rechazada y anulada son `bad` (el mismo kind que su badge) y llevan el motivo', () => {
    const tl = buildTimeline(
      order({
        status: 'cancelled',
        submitted_at: '2026-10-02T09:00:00Z',
        rejected_by_name: 'Kevin',
        rejected_at: '2026-10-02T12:00:00Z',
        rejection_reason: 'Falta factura',
        cancelled_by_name: 'Ana',
        cancelled_at: '2026-10-05T08:00:00Z',
        cancellation_reason: 'Se emitió otra',
      }),
    );
    const rej = tl.find((e) => e.kind === 'rejected')!;
    const can = tl.find((e) => e.kind === 'cancelled')!;
    expect(rej).toMatchObject({ tone: 'bad', actor: 'Kevin', reason: 'Falta factura' });
    expect(can).toMatchObject({ tone: 'bad', actor: 'Ana', reason: 'Se emitió otra' });
    expect(statusKind('paymentOrder', 'rejected')).toBe('bad');
    expect(statusKind('paymentOrder', 'cancelled')).toBe('bad');
  });
});

describe('buildTimeline — orden cronológico real', () => {
  it('rechazada, vuelta a borrador y reenviada: «enviada» va DESPUÉS de «rechazada»', () => {
    // La tabla guarda la ÚLTIMA marca de cada transición: el reenvío pisó
    // submitted_at con una fecha posterior al rechazo.
    const tl = buildTimeline(
      order({
        status: 'pending',
        rejected_by_name: 'Kevin',
        rejected_at: '2026-10-02T12:00:00Z',
        submitted_at: '2026-10-03T09:00:00Z',
      }),
    );
    expect(tl.map((e) => e.kind)).toEqual(['created', 'rejected', 'submitted']);
  });

  it('misma marca de tiempo: desempata el orden lógico (aprobada antes que pagada)', () => {
    const at = '2026-10-03T11:00:00Z';
    const tl = buildTimeline(order({ status: 'paid', approved_at: at, paid_at: at, submitted_at: at }));
    expect(tl.map((e) => e.kind)).toEqual(['created', 'submitted', 'approved', 'paid']);
  });

  it('las fechas quedan en orden ascendente para cualquier combinación', () => {
    const tl = buildTimeline(
      order({
        status: 'paid',
        paid_at: '2026-10-09T00:00:00Z',
        approved_at: '2026-10-07T00:00:00Z',
        submitted_at: '2026-10-06T00:00:00Z',
        rejected_at: '2026-10-05T00:00:00Z',
      }),
    );
    const times = tl.filter((e) => e.at).map((e) => Date.parse(e.at!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('buildTimeline — actores', () => {
  it('usuario borrado / sin nombre → null (la pantalla dice «un usuario eliminado»), nunca otro nombre', () => {
    const tl = buildTimeline(
      order({ created_by_name: null, status: 'approved', approved_at: '2026-10-02T00:00:00Z', approved_by_name: '' }),
    );
    expect(tl.map((e) => e.actor)).toEqual([null, null]);
  });

  it('autoaprobada: la marca sólo cuando quien aprobó es quien creó', () => {
    const self = buildTimeline(
      order({ status: 'approved', approved_by: 'u-ana', approved_by_name: 'Ana', approved_at: '2026-10-02T00:00:00Z' }),
    );
    expect(self.find((e) => e.kind === 'approved')?.selfApproved).toBe(true);
    const other = buildTimeline(
      order({ status: 'approved', approved_by: 'u-kevin', approved_by_name: 'Kevin', approved_at: '2026-10-02T00:00:00Z' }),
    );
    expect(other.find((e) => e.kind === 'approved')?.selfApproved).toBeUndefined();
  });
});

describe('upcomingSteps', () => {
  it('orden viva: los pasos del camino feliz que faltan, en orden', () => {
    expect(upcomingSteps('draft')).toEqual(['submitted', 'approved', 'paid']);
    expect(upcomingSteps('pending')).toEqual(['approved', 'paid']);
    expect(upcomingSteps('approved')).toEqual(['paid']);
  });

  it('terminal o rechazada: nada que esperar — para cada estado del registro', () => {
    for (const s of Object.keys(TRANSITIONS) as PaymentOrderStatus[]) {
      const live = s === 'draft' || s === 'pending' || s === 'approved';
      expect(upcomingSteps(s).length > 0, s).toBe(live);
    }
  });
});
