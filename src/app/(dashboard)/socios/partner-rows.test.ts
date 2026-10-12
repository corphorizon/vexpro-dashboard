// Reparto y historial de /socios: montos del PDF, barra proporcional, y meses
// sin dato definitivo que no se convierten en $0.
import { describe, it, expect } from 'vitest';
import { partnerShareRows } from '@/lib/monthly-close-pdf-data';
import { partnerHistory, partnerShareTable, type HistoryChainEntry } from './partner-rows';

const PARTNERS = [
  { id: 'a', name: 'Ana', email: 'ana@x.com', pct: 0.5, amount: 2290.36 },
  { id: 'b', name: 'Beto', email: null, pct: 0.3, amount: 1374.21 },
  { id: 'c', name: 'Caro', pct: 0.2, amount: 916.14 },
];

describe('partnerShareTable — reparto con % y barra', () => {
  it('montos = partnerShareRows (los del PDF de cierre), % 0..100 y barra = %', () => {
    const t = partnerShareTable(PARTNERS, true);
    const pdf = partnerShareRows(PARTNERS, true);
    expect(t.rows.map((r) => r.amount)).toEqual(pdf.rows.map((r) => r.amount));
    expect(t.total).toBe(pdf.total);
    expect(t.total).toBe(4580.71);
    expect(t.rows.map((r) => [r.name, r.sharePct, r.barPct])).toEqual([
      ['Ana', 50, 50],
      ['Beto', 30, 30],
      ['Caro', 20, 20],
    ]);
    expect(t.rows[0]).toMatchObject({ key: 'a', partnerId: 'a', email: 'ana@x.com' });
    expect(t.rows[2].email).toBeNull();
    expect(t.totalPct).toBe(100);
  });

  it('distribución no definitiva: ningún socio tiene monto (null, no $0) y el total tampoco', () => {
    const t = partnerShareTable(PARTNERS, false);
    expect(t.rows.every((r) => r.amount === null)).toBe(true);
    expect(t.total).toBeNull();
    // El % sí se sabe: es configuración, no depende del CRM.
    expect(t.rows[0].sharePct).toBe(50);
  });

  it('el pie muestra el % REAL: si no suma 100 se ve', () => {
    expect(partnerShareTable(PARTNERS.slice(0, 2), true).totalPct).toBe(80);
  });

  it('la barra se recorta a 0..100 (un % mal cargado no desborda la celda)', () => {
    const t = partnerShareTable([{ id: 'x', name: 'X', pct: 1.4, amount: 0 }, { id: 'y', name: 'Y', pct: -0.1, amount: 0 }], true);
    expect(t.rows.map((r) => r.barPct)).toEqual([100, 0]);
    expect(t.rows[0].sharePct).toBeCloseTo(140);
  });

  it('sin socios: tabla vacía, total 0 (definitivo) y 0 %', () => {
    expect(partnerShareTable([], true)).toEqual({ rows: [], total: 0, totalPct: 0 });
  });
});

describe('partnerHistory — historial multi-mes', () => {
  const periods = [
    { id: 'jul', label: 'Jul 26' },
    { id: 'ago', label: 'Ago 26' },
    { id: 'sep', label: 'Sep 26' },
    { id: 'oct', label: 'Oct 26' },
  ];
  const partners = [
    { id: 'a', percentage: 0.6 },
    { id: 'b', percentage: 0.4 },
  ];
  const chain: Record<string, HistoryChainEntry> = {
    jul: { montoDistribuir: 1000, deudaArrastradaEntrada: 0, pendiente: false },
    ago: { montoDistribuir: 0, deudaArrastradaEntrada: 250, pendiente: false },
    sep: { montoDistribuir: 999.99, deudaArrastradaEntrada: 0, pendiente: true },
  };

  const h = partnerHistory({
    periods,
    partners,
    // Julio tiene el % guardado de ese mes: manda sobre el actual.
    saved: [{ period_id: 'jul', partner_id: 'a', percentage: 0.5 }],
    chainOf: (id) => chain[id],
  });
  const by = Object.fromEntries(h.rows.map((r) => [r.periodId, r]));

  it('monto = monto a distribuir × % (el guardado del mes si existe), round2 por socio', () => {
    expect(by.jul.amounts).toEqual({ a: 500, b: 400 });
    expect(by.jul.total).toBe(900);
  });

  it('mes definitivo sin distribución: 0 de verdad, con la deuda que entró', () => {
    expect(by.ago.amounts).toEqual({ a: 0, b: 0 });
    expect(by.ago.total).toBe(0);
    expect(by.ago.debtIn).toBe(250);
  });

  it('mes pendiente (serie del CRM faltante): null por socio y en el total, no suma', () => {
    expect(by.sep).toMatchObject({ pending: true, missing: false, total: null });
    expect(by.sep.amounts).toEqual({ a: null, b: null });
  });

  it('mes que no está en la cadena: null (antes salía $0.00 por el `?? 0`)', () => {
    expect(by.oct).toMatchObject({ missing: true, pending: false, total: null, debtIn: null });
    expect(by.oct.amounts).toEqual({ a: null, b: null });
  });

  it('totales: sólo meses definitivos; los excluidos se nombran para el pie', () => {
    expect(h.partnerTotals).toEqual({ a: 500, b: 400 });
    // Σ monto a distribuir (>0) de los definitivos — lo que mostraba la pantalla.
    expect(h.grandTotal).toBe(1000);
    expect(h.excluded).toEqual(['Sep 26', 'Oct 26']);
  });
});
