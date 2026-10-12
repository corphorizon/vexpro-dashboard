// profile-view: «Guardado» sólo si el nombre quedó; el paso 2 de 2FA sólo
// con secreto real; el PIN sólo dígitos.
import { describe, it, expect } from 'vitest';
import { canContinueToVerify, nameSaveOutcome, sanitizePin } from './profile-view';

describe('sanitizePin', () => {
  it('deja sólo 6 dígitos', () => {
    expect(sanitizePin('12a3 45-678')).toBe('123456');
    expect(sanitizePin('')).toBe('');
    expect(sanitizePin('abc')).toBe('');
    expect(sanitizePin('０１２')).toBe('');
  });
});

describe('nameSaveOutcome', () => {
  it('sin guardado en curso = idle', () => {
    expect(nameSaveOutcome(null, 'Ana')).toBe('idle');
  });
  it('el nombre quedó = saved (ignora espacios de borde)', () => {
    expect(nameSaveOutcome('Ana Pérez', 'Ana Pérez')).toBe('saved');
    expect(nameSaveOutcome(' Ana ', 'Ana')).toBe('saved');
  });
  it('el nombre no cambió = unconfirmed, nunca saved', () => {
    expect(nameSaveOutcome('Ana Pérez', 'Ana')).toBe('unconfirmed');
    expect(nameSaveOutcome('Ana', null)).toBe('unconfirmed');
    expect(nameSaveOutcome('Ana', undefined)).toBe('unconfirmed');
  });
});

describe('canContinueToVerify', () => {
  it('con secreto y sin error', () => {
    expect(canContinueToVerify('JBSWY3DPEHPK3PXP', '')).toBe(true);
  });
  it('sin secreto (falló generar) o con error: no', () => {
    expect(canContinueToVerify('', '')).toBe(false);
    expect(canContinueToVerify('   ', '')).toBe(false);
    expect(canContinueToVerify('', 'Error de conexión')).toBe(false);
    expect(canContinueToVerify('JBSW', 'Error generando QR')).toBe(false);
  });
});
