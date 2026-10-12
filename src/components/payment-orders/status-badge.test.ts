// El badge de orden de pago NO tiene mapa de colores propio: lee de
// status-kind.ts (registro único). Este test falla si vuelve la copia.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { STATUS_LABELS, TRANSITIONS, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import { statusKind } from '@/components/ui/status-kind';
import { html } from '@/test/render';
import { StatusBadge } from './status-badge';

const SOURCE = readFileSync(path.join(__dirname, 'status-badge.tsx'), 'utf8');
/** Código sin comentarios (la cabecera cuenta la historia del mapa viejo). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('payment-orders/status-badge.tsx — sin mapa propio', () => {
  it('no declara un Record de estados ni variantes del Badge legado', () => {
    expect(CODE).not.toMatch(/Record<\s*PaymentOrderStatus/);
    expect(CODE).not.toMatch(/\bVARIANT\b/);
    expect(CODE).not.toMatch(/'(success|warning|danger)'/);
    expect(CODE).not.toMatch(/@\/components\/ui\/badge['"]/);
  });

  it('no escribe clases de color: el color lo pone la primitiva según statusKind', () => {
    expect(CODE).not.toMatch(/\b(text|bg)-(pos|neg|pend|info|stale|positive|negative|warning)\b/);
    expect(CODE).toMatch(/domain="paymentOrder"/);
  });

  it('para CADA estado del registro, el kind pintado es el de statusKind y la etiqueta la de STATUS_LABELS', () => {
    for (const s of Object.keys(TRANSITIONS) as PaymentOrderStatus[]) {
      const out = html(createElement(StatusBadge, { status: s }));
      expect(out, s).toContain(`data-kind="${statusKind('paymentOrder', s)}"`);
      expect(out, s).toContain(STATUS_LABELS.es[s]);
    }
  });

  it('colores pedidos por la migración: aprobada/pagada ok, pendiente pend, borrador neutral, rechazada/anulada bad', () => {
    expect(statusKind('paymentOrder', 'approved')).toBe('ok');
    expect(statusKind('paymentOrder', 'paid')).toBe('ok');
    expect(statusKind('paymentOrder', 'pending')).toBe('pend');
    expect(statusKind('paymentOrder', 'draft')).toBe('neutral');
    expect(statusKind('paymentOrder', 'rejected')).toBe('bad');
    expect(statusKind('paymentOrder', 'cancelled')).toBe('bad');
  });
});
