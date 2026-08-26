// Regresiones de los dos fallos SILENCIOSOS que ya ocurrieron acá.
//
// Los dos comparten forma: no dieron error, dieron un resultado plausible y
// equivocado. Por eso se prueba el TEXTO de la consulta y no su resultado —
// un test contra la base pasaría igual el día que el escape se rompa, porque
// "cero filas" y "cero PropFirm" se ven idénticos.

import { describe, it, expect } from 'vitest';
import { CATEGORIA_SQL, SQL_ABIERTO, SQL_CERRADO, utcDayOf, PNL_CATEGORIES } from './pnl';

describe('clasificación de cuentas', () => {
  it('escapa la barra invertida con CUATRO barras en el texto SQL', () => {
    // Los grupos son `real\PropFirm\LeverageX12`. Con menos de cuatro, el LIKE
    // no matchea NADA y PropFirm desaparece del informe sin ningún error: fue
    // exactamente lo que pasó el 2026-08-26.
    expect(CATEGORIA_SQL).toContain("LIKE 'real\\\\\\\\PropFirm%'");
  });

  it('clasifica LeverageX12 como PROPFIRM y no como categoría aparte', () => {
    // Corrección de Kevin: las X12 apalancadas SON prop firm. Que no exista una
    // rama propia para ellas es el invariante.
    expect(CATEGORIA_SQL).not.toContain('LeverageX12');
    expect(CATEGORIA_SQL).toContain("THEN 'PROPFIRM'");
  });

  it('saca la moneda de mt5_groups y no del nombre del grupo', () => {
    expect(CATEGORIA_SQL).toContain("g.Currency = 'USC'");
  });

  it('declara BOOST aunque todavía no se sepa qué grupo la identifica', () => {
    expect(PNL_CATEGORIES).toContain('BOOST');
  });
});

describe('columnas de tiempo de mt5_deals', () => {
  it('filtra por TimeMsc y NUNCA por Timestamp', () => {
    // `Timestamp` es FILETIME (100 ns desde 1601), no epoch: compararlo contra
    // un unix timestamp es verdadero para los 68 millones de filas.
    expect(SQL_CERRADO).toContain('d.TimeMsc >= ? AND d.TimeMsc < ?');
    expect(SQL_CERRADO).not.toContain('Timestamp');
  });

  it('no compara TimeMsc contra milisegundos', () => {
    // El nombre miente: es DATETIME(6). Multiplicar por 1000 devuelve cero
    // filas en 28 segundos.
    expect(SQL_CERRADO).not.toContain('1000');
    expect(SQL_CERRADO).not.toContain('UNIX_TIMESTAMP');
  });
});

describe('qué cuenta como PNL cerrado', () => {
  it('sólo la salida de la posición, y sólo compra/venta', () => {
    // Entry IN (1,3) = OUT y OUT_BY: ahí vive la ganancia realizada.
    // Action IN (0,1) deja afuera Action=2, que son depósitos y retiros. Sin
    // ese filtro un depósito grande entra al "PNL del día" como una ganancia:
    // los Action=2 de la tabla suman 425 millones.
    expect(SQL_CERRADO).toContain('d.Entry IN (1,3)');
    expect(SQL_CERRADO).toContain('d.Action IN (0,1)');
  });

  it('excluye las cuentas demo de los dos lados', () => {
    expect(SQL_ABIERTO).toContain("NOT LIKE 'demo%'");
    expect(SQL_CERRADO).toContain("NOT LIKE 'demo%'");
  });

  it('agrupa por login para poder cruzar contra el CRM después', () => {
    // Si agrupara sólo por categoría no habría forma de descartar las cuentas
    // que no están en el CRM sin volver a consultar.
    expect(SQL_ABIERTO).toContain('GROUP BY p.Login');
    expect(SQL_CERRADO).toContain('GROUP BY d.Login');
  });
});

describe('utcDayOf', () => {
  it('devuelve el día UTC, no el local', () => {
    // 23:30 en Buenos Aires (UTC-3) ya es el día siguiente en UTC.
    expect(utcDayOf(new Date('2026-08-26T02:30:00.000Z'))).toBe('2026-08-26');
    expect(utcDayOf(new Date('2026-08-26T23:59:59.999Z'))).toBe('2026-08-26');
    expect(utcDayOf(new Date('2026-08-27T00:00:00.000Z'))).toBe('2026-08-27');
  });
});
