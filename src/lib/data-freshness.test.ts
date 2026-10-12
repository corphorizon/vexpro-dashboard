import { describe, it, expect } from 'vitest';
import { isRealSyncTimestamp, relativeAgo } from './data-freshness';

// La topbar dice «Actualizado hace X» SÓLO con una marca real de
// sincronización. Estos tests fijan que «nunca sincronizó» no se convierta en
// un reloj inventado.

const t = (key: string, params?: Record<string, string>) =>
  params?.n ? `${key}:${params.n}` : key;

describe('isRealSyncTimestamp', () => {
  it('null, vacío o basura no son una marca', () => {
    expect(isRealSyncTimestamp(null)).toBe(false);
    expect(isRealSyncTimestamp(undefined)).toBe(false);
    expect(isRealSyncTimestamp('')).toBe(false);
    expect(isRealSyncTimestamp('ayer')).toBe(false);
  });

  it('la época (new Date(0)) es el relleno de «nunca», no una marca', () => {
    expect(isRealSyncTimestamp(new Date(0).toISOString())).toBe(false);
  });

  it('una fecha real sí', () => {
    expect(isRealSyncTimestamp('2026-10-12T10:00:00.000Z')).toBe(true);
  });
});

describe('relativeAgo', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('menos de un minuto (o reloj del cliente atrasado) → instantes', () => {
    expect(relativeAgo(ago(20_000), now, t)).toBe('shell.justNow');
    expect(relativeAgo(ago(-120_000), now, t)).toBe('shell.justNow');
  });

  it('minutos, horas y días', () => {
    expect(relativeAgo(ago(3 * 60_000), now, t)).toBe('shell.minutesAgo:3');
    expect(relativeAgo(ago(26 * 3_600_000), now, t)).toBe('shell.hoursAgo:26');
    expect(relativeAgo(ago(5 * 86_400_000), now, t)).toBe('shell.daysAgo:5');
  });
});
