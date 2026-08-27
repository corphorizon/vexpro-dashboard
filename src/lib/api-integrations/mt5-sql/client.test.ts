// El parseo de fechas de MT5 no puede depender de la zona del proceso: así
// nació una medición fantasma de «MT5 va 4 horas atrás de Orion» que era la
// zona horaria de la Mac que medía (UTC+4, sin DST — por eso el desfase daba
// «constante todo el año»).

import { describe, it, expect } from 'vitest';
import { mt5DateUtc } from './client';

describe('mt5DateUtc', () => {
  it('interpreta el DATETIME de MT5 como UTC, con y sin microsegundos', () => {
    expect(mt5DateUtc('2026-08-25 18:10:00')?.toISOString()).toBe('2026-08-25T18:10:00.000Z');
    expect(mt5DateUtc('2026-08-25 18:10:00.593000')?.toISOString()).toBe('2026-08-25T18:10:00.593Z');
  });

  it('respeta una fecha que ya trae zona', () => {
    expect(mt5DateUtc('2026-08-25T18:10:00.000Z')?.getTime()).toBe(Date.UTC(2026, 7, 25, 18, 10));
  });

  it('devuelve null ante basura, no una fecha inválida', () => {
    expect(mt5DateUtc('')).toBeNull();
    expect(mt5DateUtc(null)).toBeNull();
    expect(mt5DateUtc('no es una fecha')).toBeNull();
  });
});
