import { describe, it, expect } from 'vitest';
import {
  OTP_LENGTH,
  PASSWORD_MIN_LENGTH,
  loginFailureMessage,
  passwordError,
  passwordRequirements,
  sanitizeOtp,
} from './auth-form';

// t() de prueba: devuelve la clave con los params, así se ve qué se eligió.
const t = (key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

describe('PASSWORD_MIN_LENGTH', () => {
  it('es 8 — el mismo valor que exigía el servidor antes de compartir la constante', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });
});

describe('passwordRequirements', () => {
  it('vacío: nada cumplido (dos vacíos no cuentan como «coinciden»)', () => {
    expect(passwordRequirements('', '')).toEqual([
      { id: 'minLength', met: false },
      { id: 'match', met: false },
    ]);
  });
  it('largo justo en el mínimo cumple; uno menos no', () => {
    expect(passwordRequirements('a'.repeat(PASSWORD_MIN_LENGTH), '')[0].met).toBe(true);
    expect(passwordRequirements('a'.repeat(PASSWORD_MIN_LENGTH - 1), '')[0].met).toBe(false);
  });
  it('coinciden sólo si son iguales y la confirmación no está vacía', () => {
    expect(passwordRequirements('abcdefgh', 'abcdefgh')[1].met).toBe(true);
    expect(passwordRequirements('abcdefgh', 'abcdefgH')[1].met).toBe(false);
  });
});

describe('passwordError', () => {
  it('mismo orden que la página: primero el largo, después la coincidencia', () => {
    expect(passwordError('short', 'other')).toBe('tooShort');
    expect(passwordError('abcdefgh', 'abcdefgx')).toBe('mismatch');
    expect(passwordError('abcdefgh', 'abcdefgh')).toBeNull();
  });
  it('acuerda con passwordRequirements: sin error ⇔ todo cumplido', () => {
    for (const [p, c] of [['', ''], ['abc', 'abc'], ['abcdefgh', ''], ['abcdefgh', 'abcdefgh'], ['abcdefghi', 'abcdefgh']]) {
      const allMet = passwordRequirements(p, c).every((r) => r.met);
      expect(passwordError(p, c) === null, `${p}/${c}`).toBe(allMet);
    }
  });
});

describe('sanitizeOtp', () => {
  it('deja sólo dígitos y corta en OTP_LENGTH', () => {
    expect(OTP_LENGTH).toBe(6);
    expect(sanitizeOtp('123 456')).toBe('123456');
    expect(sanitizeOtp('12-34-56-78')).toBe('123456');
    expect(sanitizeOtp('abc')).toBe('');
  });
});

describe('loginFailureMessage', () => {
  it('bloqueada: manda el texto del servidor; si no hay, el nuestro', () => {
    expect(loginFailureMessage({ locked: true, error: 'Bloqueada hasta 14:05' }, t)).toBe('Bloqueada hasta 14:05');
    expect(loginFailureMessage({ locked: true }, t)).toBe('auth.login.locked');
  });
  it('bloqueo gana sobre intentos restantes', () => {
    expect(loginFailureMessage({ locked: true, attemptsLeft: 3 }, t)).toBe('auth.login.locked');
  });
  it('intentos restantes: singular y plural, con el número', () => {
    expect(loginFailureMessage({ attemptsLeft: 1 }, t)).toBe('auth.login.attemptsOne');
    expect(loginFailureMessage({ attemptsLeft: 4 }, t)).toBe('auth.login.attemptsMany(n=4)');
  });
  it('0 intentos o sin dato: el error del servidor o el genérico (0 no es «quedan 0»)', () => {
    expect(loginFailureMessage({ attemptsLeft: 0, error: 'Demasiados intentos' }, t)).toBe('Demasiados intentos');
    expect(loginFailureMessage({}, t)).toBe('auth.login.invalid');
  });
});
