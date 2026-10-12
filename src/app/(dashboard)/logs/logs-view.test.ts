// logs-view: color de la acción, paginación contada, respuesta fallida ≠ 0
// filas, y export que no descarga un CSV parcial con cara de completo.
import { describe, it, expect } from 'vitest';
import {
  auditActionKind,
  exportOutcome,
  pageRange,
  parseAuditLogResponse,
  totalPages,
} from './logs-view';

describe('auditActionKind', () => {
  it('sólo delete lleva color', () => {
    expect(auditActionKind('delete')).toBe('bad');
  });
  it.each(['create', 'update', 'login', 'logout', 'export', 'view', 'sync', 'algo_raro', ''])(
    '%s va en gris (nunca ok por defecto)',
    (a) => {
      expect(auditActionKind(a)).toBe('neutral');
    },
  );
});

describe('paginación', () => {
  it('totalPages: 0 o inválido es 1 página, nunca 0', () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(Number.NaN)).toBe(1);
    expect(totalPages(-5)).toBe(1);
    expect(totalPages(50)).toBe(1);
    expect(totalPages(51)).toBe(2);
    expect(totalPages(900)).toBe(18);
  });
  it('pageRange cuenta el recorte', () => {
    expect(pageRange(1, 900)).toEqual({ from: 1, to: 50 });
    expect(pageRange(18, 900)).toEqual({ from: 851, to: 900 });
    expect(pageRange(2, 60)).toEqual({ from: 51, to: 60 });
  });
  it('pageRange sin filas o fuera de rango es null', () => {
    expect(pageRange(1, 0)).toBeNull();
    expect(pageRange(3, 60)).toBeNull();
    expect(pageRange(1, Number.NaN)).toBeNull();
  });
});

describe('parseAuditLogResponse', () => {
  const ok = { success: true, entries: [{ id: 'a' }], total: 900, facets: { modules: ['auth'], actions: ['login'], users: ['Ana'] } };
  it('respuesta buena', () => {
    const r = parseAuditLogResponse<{ id: string }>(true, ok);
    expect(r?.entries).toHaveLength(1);
    expect(r?.total).toBe(900);
    expect(r?.facets.modules).toEqual(['auth']);
  });
  it('HTTP no ok → null (falló), no una lista vacía', () => {
    expect(parseAuditLogResponse(false, ok)).toBeNull();
  });
  it('success:false → null', () => {
    expect(parseAuditLogResponse(true, { success: false, error: 'x' })).toBeNull();
  });
  it('sin entries o cuerpo no JSON → null', () => {
    expect(parseAuditLogResponse(true, { success: true })).toBeNull();
    expect(parseAuditLogResponse(true, null)).toBeNull();
    expect(parseAuditLogResponse(true, 'html')).toBeNull();
  });
  it('total ausente no se vuelve 0 con filas en pantalla', () => {
    const r = parseAuditLogResponse(true, { success: true, entries: [{}, {}] });
    expect(r?.total).toBe(2);
  });
  it('facetas ausentes o con basura → listas vacías tipadas', () => {
    const r = parseAuditLogResponse(true, { success: true, entries: [], total: 0, facets: { modules: [1, 'x'] } });
    expect(r?.facets).toEqual({ modules: ['x'], actions: [], users: [] });
  });
});

describe('exportOutcome', () => {
  it('completo', () => {
    expect(exportOutcome(900, 900, false)).toEqual({ kind: 'complete', rows: 900 });
    expect(exportOutcome(0, 0, false)).toEqual({ kind: 'complete', rows: 0 });
  });
  it('tope alcanzado: se cuenta N de M', () => {
    expect(exportOutcome(10_000, 12_345, false)).toEqual({ kind: 'capped', rows: 10_000, total: 12_345 });
  });
  it('una página falló: failed aunque haya filas (no se descarga parcial)', () => {
    expect(exportOutcome(400, 900, true)).toEqual({ kind: 'failed', rows: 400, total: 900 });
    expect(exportOutcome(0, null, true)).toEqual({ kind: 'failed', rows: 0, total: null });
  });
  it('total desconocido sin falla: completo con lo que hay', () => {
    expect(exportOutcome(12, null, false)).toEqual({ kind: 'complete', rows: 12 });
  });
});
