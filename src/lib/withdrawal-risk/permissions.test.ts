// ─────────────────────────────────────────────────────────────────────────────
// El reparto de permisos de la Revisión de Retiros es una segregación de
// funciones, no una comodidad: soporte triajea y escala, el auditor aprueba.
// Quien atiende al cliente que reclama su retiro no debería ser quien libera
// el dinero.
//
// Se fija con tests porque es exactamente el tipo de regla que alguien
// "simplifica" seis meses después para destrabar un caso urgente, y ahí se
// pierde el control sin que nadie lo note.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  WITHDRAWAL_REVIEW_READ_ROLES,
  roleCanReadWithdrawalReview,
  roleCanTriageWithdrawal,
  roleCanApproveWithdrawal,
} from '@/lib/roles';

describe('permisos de revisión de retiros', () => {
  it('soporte VE la cola', () => {
    expect(roleCanReadWithdrawalReview('soporte')).toBe(true);
  });

  it('soporte puede escalar pero NO aprobar ni rechazar', () => {
    expect(roleCanTriageWithdrawal('soporte')).toBe(true);
    expect(roleCanApproveWithdrawal('soporte')).toBe(false);
  });

  it('el auditor ve y aprueba: es el rol al que se escala', () => {
    expect(roleCanReadWithdrawalReview('auditor')).toBe(true);
    expect(roleCanApproveWithdrawal('auditor')).toBe(true);
  });

  it('admin y superadmin pueden todo', () => {
    for (const r of ['admin', 'superadmin']) {
      expect(roleCanReadWithdrawalReview(r)).toBe(true);
      expect(roleCanApproveWithdrawal(r)).toBe(true);
    }
  });

  it('los roles ajenos al módulo no entran ni de lectura', () => {
    // 'hr' escribe en su propio dominio y 'socio' tiene muchos módulos: ni uno
    // ni otro tienen nada que hacer en la cola de retiros.
    for (const r of ['hr', 'socio', 'invitado', '']) {
      expect(roleCanReadWithdrawalReview(r)).toBe(false);
      expect(roleCanTriageWithdrawal(r)).toBe(false);
      expect(roleCanApproveWithdrawal(r)).toBe(false);
    }
  });

  it('aprobar es SIEMPRE un subconjunto de leer: nadie decide sin ver', () => {
    for (const r of [...WITHDRAWAL_REVIEW_READ_ROLES, 'hr', 'socio', 'invitado', 'superadmin']) {
      if (roleCanApproveWithdrawal(r)) expect(roleCanReadWithdrawalReview(r)).toBe(true);
    }
  });

  it('el set de lectura no se ensancha sin que este test lo diga', () => {
    // Si alguien agrega un rol acá, tiene que venir a cambiar esta línea y
    // preguntarse por qué.
    expect([...WITHDRAWAL_REVIEW_READ_ROLES].sort()).toEqual(['admin', 'auditor', 'soporte']);
  });
});
