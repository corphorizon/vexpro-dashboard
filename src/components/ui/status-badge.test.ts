// statusKind (el único mapa estado → color) y StatusBadge.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { TRANSITIONS } from '@/lib/payment-orders/types';
import { STATUS_DOMAINS, STATUS_KINDS, isKnownStatus, statusKind, type StatusDomain } from './status-kind';
import { STATUS_BADGE_CLASSES, StatusBadge } from './status-badge';
import { html } from '@/test/render';

describe('statusKind', () => {
  it('cubre TODOS los estados de orden de pago del registro canónico (TRANSITIONS)', () => {
    for (const s of Object.keys(TRANSITIONS)) {
      expect(isKnownStatus('paymentOrder', s), s).toBe(true);
      expect(STATUS_KINDS).toContain(statusKind('paymentOrder', s));
    }
  });

  it('mapea los estados con significado de dinero', () => {
    expect(statusKind('paymentOrder', 'paid')).toBe('ok');
    expect(statusKind('paymentOrder', 'approved')).toBe('ok'); // isAuthorized — ver cabecera
    expect(statusKind('paymentOrder', 'pending')).toBe('pend');
    expect(statusKind('paymentOrder', 'rejected')).toBe('bad');
    expect(statusKind('expense', 'pagado')).toBe('ok');
    expect(statusKind('expense', 'parcial')).toBe('pend');
    expect(statusKind('paypros', 'unpaid')).toBe('pend');
    expect(statusKind('paypros', 'payout_declined')).toBe('bad');
    expect(statusKind('fetch', 'stale')).toBe('stale');
    expect(statusKind('fetch', 'error')).toBe('bad');
  });

  it('lo desconocido o vacío es neutral, NUNCA ok', () => {
    const domains = Object.keys(STATUS_DOMAINS) as StatusDomain[];
    for (const d of domains) {
      for (const s of ['', null, undefined, 'PAID', 'unknown', 'toString', '__proto__', 'constructor']) {
        expect(statusKind(d, s as string | null | undefined), `${d}:${String(s)}`).toBe('neutral');
      }
    }
  });

  it('el mismo nombre en dominios distintos no se cruza', () => {
    // «pending» es estado de orden; en egresos no existe (allá es «pendiente»).
    expect(isKnownStatus('expense', 'pending')).toBe(false);
    expect(statusKind('expense', 'pending')).toBe('neutral');
  });
});

describe('StatusBadge', () => {
  it('cada kind tiene clases de token (nada de paleta cruda)', () => {
    for (const k of STATUS_KINDS) {
      const cls = STATUS_BADGE_CLASSES[k];
      expect(cls, k).toBeTruthy();
      expect(cls).not.toMatch(/-(red|green|emerald|amber|blue|slate|gray)-\d/);
      expect(cls).not.toMatch(/dark:/);
    }
  });

  it('renderiza punto + texto, 20 px y rounded-full', () => {
    const out = html(createElement(StatusBadge, { kind: 'ok', label: 'Pagado' }));
    expect(out).toContain('Pagado');
    expect(out).toContain('h-5');
    expect(out).toContain('rounded-full');
    expect(out).toContain('text-pos bg-pos-bg');
    expect(out).toContain('size-1.5 shrink-0 rounded-full bg-current'); // el punto
  });

  it('stale lleva reloj en vez de punto', () => {
    const out = html(createElement(StatusBadge, { kind: 'stale', label: 'hace 26 h' }));
    expect(out).toContain('<svg');
    expect(out).not.toContain('bg-current');
  });

  it('con domain + status usa statusKind', () => {
    const out = html(createElement(StatusBadge, { domain: 'paymentOrder', status: 'rejected', label: 'Rechazada' }));
    expect(out).toContain('data-kind="bad"');
    const unknown = html(createElement(StatusBadge, { domain: 'paymentOrder', status: 'weird', label: '?' }));
    expect(unknown).toContain('data-kind="neutral"');
  });
});
