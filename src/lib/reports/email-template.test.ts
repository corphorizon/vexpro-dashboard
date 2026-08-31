// ─────────────────────────────────────────────────────────────────────────────
// El correo no puede decir en verde algo que el bloque de abajo desmiente.
//
// Tres bugs de la auditoría del 2026-08-31, fijados acá:
//   1. `connected` no se leía en NINGÚN lado. Una sección sin fuente salía con
//      $0,00 y 0 usuarios, indistinguible de una empresa que no vendió nada.
//   2. El P&L nulo se colapsaba a 0 con un `?? 0` en data.ts: el KPI decía
//      «Broker P&L $0,00» en verde mientras el bloque del CRM, honesto, decía
//      «29 días sin dato». AP Markets, agosto 2026.
//   3. El badge «mock» —el que avisa que los datos son falsos— salía él mismo
//      roto: `${BRAND_HEX.warning}` estaba dentro de un string entre comillas
//      SIMPLES, así que el correo imprimía ese texto como valor de `color:`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { renderReportEmail, renderReportEmailText } from './email-template';
import type { ReportData } from './data';

const EMPTY_BUCKET = {
  deposits: [], withdrawals: [],
  total_deposits: 0, total_withdrawals: 0, net_deposit: 0,
};

function report(overrides: Partial<ReportData> = {}): ReportData {
  return {
    range: { from: '2026-08-01', to: '2026-08-31' },
    this_month: { from: '2026-08-01', to: '2026-08-31' },
    prev_month: { from: '2026-07-01', to: '2026-07-31' },
    deposits_withdrawals: {
      range: EMPTY_BUCKET,
      month: EMPTY_BUCKET,
      prev_month: { total_deposits: 0, total_withdrawals: 0, net_deposit: 0 },
    },
    crm_users: {
      new_users_in_range: 0, new_users_this_month: 0, total_users: 0,
      connected: false, isMock: false,
    },
    broker_pnl: {
      pnl_range: null, pnl_month: null, pnl_prev_month: null,
      connected: false, isMock: false, crm: null,
    },
    prop_trading: {
      products: null,
      total_sales_range: null, total_sales_month: null,
      prop_withdrawals_range: null, prop_withdrawals_count_range: null,
      pnl_range: null, pnl_month: null, pnl_prev_month: null,
      connected: false, isMock: false,
    },
    balances_by_channel: { channels: [], total: 0, asOf: '2026-08-31' },
    company_result: null,
    anyMock: false,
    failures: [],
    truncated: [],
    ...overrides,
  } as ReportData;
}

function html(data: ReportData): string {
  return renderReportEmail({ data, cadence: 'daily', companyName: 'Vex Pro', locale: 'es' });
}

describe('secciones sin fuente conectada', () => {
  it('no dibujan ceros: dicen que no hay fuente', () => {
    const out = html(report());
    // Las TRES secciones de CRM (usuarios, broker P&L, prop trading) dicen lo
    // mismo: no hay fuente. Antes las tres dibujaban ceros.
    expect(out.split('no tiene fuente conectada').length - 1).toBe(3);
  });

  it('con espejo cargado sí muestran los conteos', () => {
    const out = html(
      report({
        crm_users: {
          new_users_in_range: 180, new_users_this_month: 2519, total_users: 21680,
          connected: true, isMock: false,
        },
      }),
    );
    expect(out).toContain('21.680');
    expect(out).toContain('180');
  });
});

describe('un P&L que no se conoce no se dibuja como cero', () => {
  const withCrm = report({
    broker_pnl: {
      pnl_range: null, pnl_month: null, pnl_prev_month: null,
      connected: true, isMock: false,
      crm: {
        last_day: '2026-08-30', last_broker_pnl: null, broker_pnl_range: null,
        volume_lots_range: 0, deals_range: 0, days_with_data: 0,
        days_missing: Array.from({ length: 29 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`),
      },
    },
  });

  it('el KPI dice «sin dato», no $0,00 en verde', () => {
    const out = html(withCrm);
    // Tres KPI de P&L, los tres «sin dato». Antes eran tres «$0.00» en verde.
    const seccion = out.slice(out.indexOf('Broker P&amp;L'));
    expect(seccion.split('sin dato').length - 1).toBeGreaterThanOrEqual(3);
    expect(seccion).not.toContain('$0.00');
  });

  it('el cuerpo en TEXTO PLANO tampoco inventa el cero', () => {
    const text = renderReportEmailText({
      data: withCrm, cadence: 'daily', companyName: 'Vex Pro', locale: 'es',
    });
    expect(text).toContain('sin dato');
    expect(text).not.toMatch(/Rango: \$0\.00/);
  });

  it('sin PNL del mes no hay comparación inventada contra cero', () => {
    // El bug: `?? 0` en las dos puntas daba «−100%» o «+∞» con cara de dato.
    const out = html(withCrm);
    expect(out).not.toContain('-100%');
  });
});

describe('el badge «mock» se renderiza de verdad', () => {
  it('no imprime la expresión sin interpolar', () => {
    const out = html(
      report({
        crm_users: {
          new_users_in_range: 1, new_users_this_month: 1, total_users: 1,
          connected: false, isMock: true,
        },
        prop_trading: {
          products: null,
          total_sales_range: 1, total_sales_month: 1,
          prop_withdrawals_range: 0, prop_withdrawals_count_range: 0,
          pnl_range: 1, pnl_month: 1, pnl_prev_month: 1,
          connected: false, isMock: true,
        },
      }),
    );
    expect(out).toContain('· mock');
    // Éste era el bug literal: el texto crudo llegaba al correo.
    expect(out).not.toContain('${BRAND_HEX.warning}');
  });
});

describe('«Productos vendidos» sin desglose', () => {
  it('dice que no hay desglose en vez de mostrar una tabla vacía', () => {
    const out = html(
      report({
        prop_trading: {
          products: null,
          total_sales_range: 11_981.7, total_sales_month: 11_981.7,
          prop_withdrawals_range: 2_819.04, prop_withdrawals_count_range: 3,
          pnl_range: 9_162.66, pnl_month: 9_162.66, pnl_prev_month: null,
          connected: true, isMock: false,
        },
      }),
    );
    expect(out).toContain('Sin desglose disponible');
    // Y el total del rango SÍ se muestra: lo que falta es el desglose.
    expect(out).toContain('11,981.70');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// El flag `truncated` tiene que LLEGAR al correo, no morir en la API
// (2026-08-31, auditoría de finanzas, ítem 19).
// ─────────────────────────────────────────────────────────────────────────────
describe('cifras recortadas por el techo de filas', () => {
  it('sin recorte no hay aviso', () => {
    expect(html(report())).not.toContain('CIFRAS INCOMPLETAS');
  });

  it('con recorte el correo lo dice, y nombra la fuente', () => {
    const out = html(report({ truncated: ['api_transactions (rango)'] }));
    expect(out).toContain('CIFRAS INCOMPLETAS');
    expect(out).toContain('api_transactions (rango)');
    // Y dice en qué DIRECCIÓN está el error: un total corto se confunde con un
    // mes flojo, y saber que sólo puede ser menor cambia qué se hace con él.
    expect(out).toContain('CORTOS');
  });

  it('la versión de texto plano también lo lleva', () => {
    // El correo se manda multipart: quien lo lea en texto no puede quedarse sin
    // el aviso que sí lleva el HTML.
    const txt = renderReportEmailText({
      data: report({ truncated: ['api_transactions (mes)'] }),
      cadence: 'daily',
      companyName: 'Vex Pro',
      locale: 'es',
    });
    expect(txt).toContain('CIFRAS INCOMPLETAS');
    expect(txt).toContain('api_transactions (mes)');
  });

  it('es un aviso DISTINTO del de una fuente caída', () => {
    // `failures` = no respondió y se ve un hueco. `truncated` = respondió un
    // número plausible y menor que el real. Confundirlos hace que el segundo se
    // lea como «faltan datos de una sección» en vez de «este número está mal».
    const out = html(report({ failures: ['crm_daily_pnl'], truncated: ['api_transactions (rango)'] }));
    expect(out).toContain('no respondieron');
    expect(out).toContain('CIFRAS INCOMPLETAS');
  });
});
