// La marca de MT5 es un entero de 18 dígitos que parece cualquier cosa menos
// una fecha. Una conversión mal hecha no rompe nada visible: muestra una fecha
// plausible y equivocada, que es peor que no mostrar nada.

import { describe, it, expect } from 'vitest';
import { mt5TimestampToIso } from './timestamps';

describe('mt5TimestampToIso', () => {
  it('convierte una marca real leída de producción', () => {
    // Valor real de MAX(Timestamp) en mt5_deals de Vex Pro, leído el
    // 2026-08-24 a las 19:33 UTC — el export iba 40 segundos atrás.
    expect(mt5TimestampToIso('134320735965812560')).toBe('2026-08-24T19:33:16.581Z');
  });

  it('acepta bigint y string por igual', () => {
    expect(mt5TimestampToIso(BigInt('134320735965812560'))).toBe(
      mt5TimestampToIso('134320735965812560'),
    );
  });

  it('devuelve null en vez de una fecha inventada', () => {
    // Preferimos "no hay dato" antes que una fecha creíble y falsa: la primera
    // se nota, la segunda se cree.
    for (const v of [null, undefined, '', '0', -5, 'no-es-un-numero', {}]) {
      expect(mt5TimestampToIso(v)).toBeNull();
    }
  });

  it('rechaza valores fuera del rango razonable', () => {
    // Un segundo desde 1601 daría el año 1601: si eso aparece, el valor no era
    // una marca de MT5 y no hay que dibujarlo como fecha.
    expect(mt5TimestampToIso('10000000')).toBeNull();
    expect(mt5TimestampToIso('999999999999999999')).toBeNull();
  });
});
