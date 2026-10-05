// Preparar ≠ decidir en Órdenes de Pago (roles.ts, 2026-10-05).
// La regla la usan el servidor (/transition → 403) y la UI (qué botón se
// dibuja): si este test cambia, cambian las dos puntas a la vez.
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_ORDER_PREPARE_ROLES,
  FINANCE_ROLES,
  paymentOrderTransitionNeedsFinance,
  roleCanPreparePaymentOrder,
  roleCanWriteFinance,
} from './roles';

describe('órdenes de pago: preparar vs decidir', () => {
  it('RRHH prepara pero no decide', () => {
    expect(roleCanPreparePaymentOrder('hr')).toBe(true);
    expect(roleCanWriteFinance('hr')).toBe(false);
  });

  it('todo rol de finanzas también prepara (preparar es un subconjunto)', () => {
    for (const r of FINANCE_ROLES) expect(PAYMENT_ORDER_PREPARE_ROLES).toContain(r);
    expect(roleCanPreparePaymentOrder('superadmin')).toBe(true);
  });

  it('socio y soporte ni preparan ni deciden', () => {
    for (const r of ['socio', 'soporte', '']) {
      expect(roleCanPreparePaymentOrder(r)).toBe(false);
      expect(roleCanWriteFinance(r)).toBe(false);
    }
  });

  it('enviar, retirar a borrador y anular un borrador NO exigen finanzas', () => {
    expect(paymentOrderTransitionNeedsFinance('draft', 'pending')).toBe(false);
    expect(paymentOrderTransitionNeedsFinance('pending', 'draft')).toBe(false);
    expect(paymentOrderTransitionNeedsFinance('rejected', 'draft')).toBe(false);
    expect(paymentOrderTransitionNeedsFinance('draft', 'cancelled')).toBe(false);
    expect(paymentOrderTransitionNeedsFinance('rejected', 'cancelled')).toBe(false);
  });

  it('aprobar, rechazar, pagar y anular lo enviado/aprobado SÍ exigen finanzas', () => {
    expect(paymentOrderTransitionNeedsFinance('pending', 'approved')).toBe(true);
    expect(paymentOrderTransitionNeedsFinance('pending', 'rejected')).toBe(true);
    expect(paymentOrderTransitionNeedsFinance('approved', 'paid')).toBe(true);
    expect(paymentOrderTransitionNeedsFinance('pending', 'cancelled')).toBe(true);
    expect(paymentOrderTransitionNeedsFinance('approved', 'cancelled')).toBe(true);
  });
});
