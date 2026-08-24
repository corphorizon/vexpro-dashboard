// El token de un aplicativo es una llave a datos del bróker. Lo que se fija
// acá no es "que funcione" sino que NO se guarde el secreto y que el alcance
// no dependa de nada que mande quien llama.

import { describe, it, expect } from 'vitest';
import { generatePartnerToken, hashToken } from './auth';

describe('generatePartnerToken', () => {
  it('genera tokens distintos cada vez', () => {
    const a = generatePartnerToken();
    const b = generatePartnerToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('el token lleva prefijo reconocible y suficiente entropía', () => {
    const { token } = generatePartnerToken();
    expect(token.startsWith('sdk_')).toBe(true);
    // 32 bytes en base64url ≈ 43 caracteres. Menos que eso sería adivinable.
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('el prefijo guardado NO alcanza para reconstruir el token', () => {
    // El prefijo existe para poder decir "el token de Atlas que empieza en…"
    // en un log sin revelar el secreto.
    const { token, prefix } = generatePartnerToken();
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length / 2);
  });

  it('el hash es SHA-256 y no contiene el token', () => {
    const { token, hash } = generatePartnerToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(4));
    // Determinista: es lo que permite buscar POR el hash en vez de comparar
    // secretos en nuestro código.
    expect(hashToken(token)).toBe(hash);
  });

  it('un token distinto por un solo carácter da otro hash', () => {
    const { token } = generatePartnerToken();
    expect(hashToken(token)).not.toBe(hashToken(token + 'x'));
  });
});
