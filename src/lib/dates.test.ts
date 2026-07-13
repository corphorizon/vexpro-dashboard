import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatDateRelative } from './dates';

// BUG-06: una fecha-solo "YYYY-MM-DD" debe mostrarse tal cual (fecha de
// calendario), sin correrse al día anterior en husos negativos (LatAm). El
// fix la parsea como medianoche LOCAL, así que estos tests pasan en cualquier
// timezone donde corra CI.

describe('formatDate — fecha-solo (BUG-06)', () => {
  it('muestra el día del calendario sin shift de timezone', () => {
    expect(formatDate('2026-06-07')).toBe('07/06/2026');
    expect(formatDate('2026-01-01')).toBe('01/01/2026');
    expect(formatDate('2026-12-31')).toBe('31/12/2026');
  });

  it('zero-padea día y mes', () => {
    expect(formatDate('2026-03-05')).toBe('05/03/2026');
  });

  it('nullish / vacío / inválido → string vacío', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('no-es-fecha')).toBe('');
  });

  it('acepta Date directo', () => {
    expect(formatDate(new Date(2026, 5, 7))).toBe('07/06/2026'); // mes 5 = junio (0-indexed)
  });
});

describe('formatDateTime', () => {
  it('agrega hora 24h a un datetime', () => {
    // Date local explícito → hora local determinística
    expect(formatDateTime(new Date(2026, 5, 7, 14, 30))).toBe('07/06/2026 14:30');
  });
  it('nullish → vacío', () => {
    expect(formatDateTime(null)).toBe('');
  });
});

describe('formatDateRelative', () => {
  it('formato corto con mes localizado', () => {
    // es locale → "07 jun 2026" (o similar). Verificamos que no esté vacío y
    // contenga el año; el nombre del mes depende del ICU del entorno.
    const out = formatDateRelative('2026-06-07');
    expect(out).not.toBe('');
    expect(out).toContain('2026');
  });
});
