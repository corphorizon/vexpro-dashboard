import { describe, it, expect } from 'vitest';
import {
  BUSINESS_MODELS,
  DEFAULT_BUSINESS_MODEL,
  normalizeBusinessModel,
  features,
  uploadSections,
  defaultUploadSection,
  blockedModules,
  moduleAllowedForModel,
} from './business-model';
import { blockedReportSections, blockedConsolidatedColumns } from './business-model';
import { REPORT_SECTION_KEYS } from './reports/sections';
import { MODULES } from './modules';

describe('modelo de negocio', () => {
  // El default protege a las empresas que existían antes de esta distinción:
  // una migración no puede cambiar en silencio lo que Vex Pro ve.
  it('cualquier valor desconocido cae en broker', () => {
    expect(DEFAULT_BUSINESS_MODEL).toBe('broker');
    expect(normalizeBusinessModel(null)).toBe('broker');
    expect(normalizeBusinessModel('cualquiera')).toBe('broker');
    expect(normalizeBusinessModel('company')).toBe('company');
  });

  // Esta prueba nació guardando la promesa "introducir el modelo `company` no
  // le quita nada a un broker". Esa promesa sigue en pie para todo lo suyo; lo
  // que cambió (Kevin, 2026-08-26) es que la facturación por concepto NUNCA
  // fue suyo: Ingresos y Clientes son la contabilidad de una empresa de
  // servicios. Medido antes de apagarlo, los cuatro brokers tenían CERO líneas
  // de ingreso — las 70 que existen son de Horizon, que es `company`.
  it('un broker conserva todo lo suyo, pero no factura por concepto', () => {
    const f = features('broker');
    expect(f).toEqual({
      deposits: true, withdrawals: true, netDeposit: true, brokerPnl: true,
      movements: true, liquidity: true, liquidityPool: false, investments: true,
      // `hedgeFund` se sumó el 2026-09-02 (migración 125) y es EXCLUSIVO del
      // broker: es dinero de clientes de una plataforma de trading.
      hedgeFund: true,
      incomeLines: false, riskManagement: true, commercialTeam: true,
      cashBasisExpenses: false, accounting: true,
    });
    // Lo propio del broker sigue intacto: nada de esto puede aparecer acá.
    for (const suyo of ['movements', 'liquidity', 'investments', 'risk', 'commissions']) {
      expect(blockedModules('broker')).not.toContain(suyo);
    }
    // Y los dos que se apagaron van juntos: son la misma contabilidad. El
    // pool de liquidez se sumó el 2026-09-01: administrarlo es un negocio
    // propio (modelo `liquidity_provider`), no algo que haga un broker.
    expect(blockedModules('broker')).toEqual(['liquidity_pool', 'income', 'clients']);
    // Y el hedge fund es SUYO: es el único modelo que lo tiene.
    expect(blockedModules('broker')).not.toContain('hedge_fund');
    expect(moduleAllowedForModel('company', 'hedge_fund')).toBe(false);
    expect(moduleAllowedForModel('liquidity_provider', 'hedge_fund')).toBe(false);
  });

  it('los módulos de facturación siguen encendidos para una empresa de servicios', () => {
    // El riesgo del cambio anterior es apagarlos de más. Horizon vive de esto.
    expect(moduleAllowedForModel('company', 'income')).toBe(true);
    expect(moduleAllowedForModel('company', 'clients')).toBe(true);
    expect(moduleAllowedForModel('broker', 'income')).toBe(false);
    expect(moduleAllowedForModel('broker', 'clients')).toBe(false);
  });

  it('una empresa de servicios no tiene depósitos, retiros ni riesgo', () => {
    const f = features('company');
    expect(f.deposits).toBe(false);
    expect(f.withdrawals).toBe(false);
    expect(f.netDeposit).toBe(false);
    expect(f.riskManagement).toBe(false);
    expect(f.movements).toBe(false);
    expect(f.liquidity).toBe(false);
    expect(f.liquidityPool).toBe(false);
    expect(f.investments).toBe(false);
    // Ni hedge fund: una consultora no le vende un producto de inversión a
    // clientes que no tiene.
    expect(f.hedgeFund).toBe(false);
    // Sí lleva contabilidad: Horizon vive de cargar egresos y cerrar meses.
    expect(f.accounting).toBe(true);
    // Pero sí factura: el detalle de ingresos es su contabilidad.
    expect(f.incomeLines).toBe(true);
  });
});

describe('pestañas de carga', () => {
  it('el broker mantiene su orden histórico', () => {
    expect(uploadSections('broker')).toEqual([
      'depositos', 'retiros', 'egresos', 'ingresos', 'liquidez', 'inversiones',
    ]);
    expect(defaultUploadSection('broker')).toBe('depositos');
  });

  it('la empresa arranca por Ingresos y no ve depósitos ni retiros', () => {
    expect(uploadSections('company')).toEqual(['ingresos', 'egresos']);
    expect(moduleAllowedForModel('broker', 'upload')).toBe(true);
    expect(moduleAllowedForModel('company', 'upload')).toBe(true);
    expect(defaultUploadSection('company')).toBe('ingresos');
  });

  // El módulo `upload` y sus pestañas contestan la MISMA pregunta y se derivan
  // uno del otro: no puede haber pantalla sin pestañas ni pestañas sin
  // pantalla. Este test es el candado de esa equivalencia.
  it('tener pestañas y tener el módulo de carga son lo mismo', () => {
    for (const m of BUSINESS_MODELS) {
      const tienePestanas = uploadSections(m).length > 0;
      expect(moduleAllowedForModel(m, 'upload'), `${m}`).toBe(tienePestanas);
      // `null` explícito, no un `undefined` con tipo `string`.
      expect(defaultUploadSection(m) === null, `${m}`).toBe(!tienePestanas);
    }
  });

  it('el proveedor de liquidez carga SOLO inversiones', () => {
    // Kevin, 2026-09-01: «con la pestaña reducida a inversiones, nada más».
    // Ni depósitos, ni retiros, ni egresos, ni ingresos, ni liquidez.
    expect(uploadSections('liquidity_provider')).toEqual(['inversiones']);
    expect(defaultUploadSection('liquidity_provider')).toBe('inversiones');
  });
});

describe('módulos bloqueados', () => {
  it('la empresa no accede a riesgo ni al equipo comercial', () => {
    const blocked = blockedModules('company');
    expect(blocked).toContain('risk');
    expect(blocked).toContain('commissions');
    expect(blocked).toContain('ib_rebates');
    expect(blocked).toContain('movements');
    expect(blocked).toContain('liquidity');
    expect(blocked).toContain('investments');
    expect(blocked).toContain('liquidity_pool');
    expect(moduleAllowedForModel('company', 'risk')).toBe(false);
    // RRHH sigue accesible: la empresa lleva empleados, no comerciales.
    expect(moduleAllowedForModel('company', 'hr')).toBe(true);
    expect(moduleAllowedForModel('company', 'expenses')).toBe(true);
  });

  // Un módulo bloqueado que no existe no bloquea nada y nadie se entera.
  it('todo módulo bloqueado es un módulo real', () => {
    const known = new Set(MODULES.map((m) => m.key));
    for (const model of BUSINESS_MODELS) {
      for (const key of blockedModules(model)) {
        expect(known, `${model} bloquea ${key}`).toContain(key);
      }
    }
  });
});

describe('secciones del reporte por email', () => {
  it('el broker las recibe todas', () => {
    expect(blockedReportSections('broker')).toEqual([]);
  });

  // Mandar "Depósitos y retiros: $0" todos los días es peor que no mandarlo.
  it('la empresa no recibe las de broker', () => {
    const blocked = blockedReportSections('company');
    expect(blocked).toContain('deposits_withdrawals');
    expect(blocked).toContain('broker_pnl');
    expect(blocked).toContain('prop_trading');
    // Los usuarios del CRM son los clientes de la plataforma de trading del
    // broker. Sin bloquearla, el reporte diario de una consultora llegaba con
    // "Usuarios CRM: 0" como una de sus dos únicas secciones.
    expect(blocked).toContain('crm_users');
  });
});

describe('brokerPnl es el interruptor de la cadena de distribución', () => {
  // Si alguien pone brokerPnl en true para 'company' (o lo saca del contrato),
  // la neutralización de buildDistributionInputs deja de aplicar y vuelve la
  // plata fantasma. Este test es el candado.
  it("solo 'broker' factura por P&L de broker / prop firm", () => {
    expect(features('broker').brokerPnl).toBe(true);
    expect(features('company').brokerPnl).toBe(false);
  });

  it('la empresa factura por líneas de ingreso, que siguen encendidas', () => {
    expect(features('company').incomeLines).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proveedor de liquidez (Kevin, 2026-09-01)
// «solo necesito lo del pool y lo de inversiones» — una empresa INFORMATIVA.
// ─────────────────────────────────────────────────────────────────────────────
describe('proveedor de liquidez', () => {
  const M = 'liquidity_provider';

  it('es un modelo reconocido y no se cae al default', () => {
    expect(BUSINESS_MODELS).toContain(M);
    expect(normalizeBusinessModel(M)).toBe(M);
    // Y el que no existe sigue cayendo en broker: agregar un modelo no puede
    // cambiar en silencio lo que ve una empresa vieja.
    expect(normalizeBusinessModel('liquidity_pool')).toBe('broker');
  });

  it('tiene EXACTAMENTE dos cosas encendidas: el pool y las inversiones', () => {
    const f = features(M);
    const encendidas = Object.entries(f).filter(([, v]) => v).map(([k]) => k).sort();
    expect(encendidas).toEqual(['investments', 'liquidityPool']);
  });

  it('el pool es suyo y de nadie más', () => {
    expect(moduleAllowedForModel(M, 'liquidity_pool')).toBe(true);
    expect(moduleAllowedForModel('broker', 'liquidity_pool')).toBe(false);
    expect(moduleAllowedForModel('company', 'liquidity_pool')).toBe(false);
    // Y NO es la pantalla de conciliación de Vex Pro, que es otra cosa.
    expect(moduleAllowedForModel(M, 'liquidity')).toBe(false);
  });

  it('conserva Inversiones — Kevin lo pidió explícito', () => {
    expect(moduleAllowedForModel(M, 'investments')).toBe(true);
    expect(features(M).investments).toBe(true);
  });

  it('no lleva contabilidad: ni cierre, ni socios, ni reportes', () => {
    for (const m of ['expenses', 'balances', 'partners', 'payment_orders', 'periods', 'reports']) {
      expect(moduleAllowedForModel(M, m), m).toBe(false);
    }
  });

  it('SÍ tiene la carga de datos, y con una sola pestaña', () => {
    // Es la única pantalla que escribe en `investments` (/inversiones es de
    // solo lectura), así que sin ella el módulo Inversiones nunca tendría un
    // dato. Kevin lo decidió el 2026-09-01 con esa evidencia.
    expect(moduleAllowedForModel(M, 'upload')).toBe(true);
    expect(uploadSections(M)).toEqual(['inversiones']);
    // Y no se prendió nada de rebote: la contabilidad sigue afuera.
    expect(features(M).accounting).toBe(false);
  });

  it('lo que hace que la app se pueda usar sigue accesible', () => {
    // `summary` NO se puede bloquear: es el destino del dispatcher para todo
    // usuario no-admin del grupo Finanzas (module-groups.ts, homeHref
    // '/resumen-general'). Bloquearlo lo deja aterrizando en un 403.
    for (const m of ['summary', 'users', 'logs']) {
      expect(moduleAllowedForModel(M, m), m).toBe(true);
    }
  });

  it('no recibe NINGUNA sección del reporte diario', () => {
    // Las cinco bloqueadas ⇒ el mail no tiene nada que contar. Por eso además
    // el módulo `reports` está bloqueado y sendReports mira el modelo: Exura
    // Liquidez venía recibiendo el diario en $0.
    expect(new Set(blockedReportSections(M))).toEqual(new Set(REPORT_SECTION_KEYS));
  });

  it('no muestra columnas de broker en el consolidado, pero sí inversiones', () => {
    const blocked = blockedConsolidatedColumns(M);
    for (const c of ['totalDeposits', 'totalWithdrawals', 'p2p', 'netDeposit', 'brokerPnl', 'propFirmNet', 'propFirmSales']) {
      expect(blocked, c).toContain(c);
    }
    expect(blocked).not.toContain('investmentProfits');
  });
});

describe('ningún modelo pierde lo que ya tenía', () => {
  // El candado del cambio de 2026-09-01: agregar un tercer modelo no puede
  // quitarle un módulo a los dos que ya existían. Lo único que se les sacó
  // —a los dos, y a propósito— es `liquidity_pool`.
  it('broker y company mantienen sus módulos, salvo el pool', () => {
    const antes: Record<string, string[]> = {
      broker: ['income', 'clients'],
      company: ['risk', 'commissions', 'ib_rebates', 'movements', 'liquidity', 'investments'],
    };
    // `hedge_fund` (migración 125, 2026-09-02) se suma a los bloqueados de
    // TODOS los modelos menos `broker`, que es el único que vende el producto.
    // Al broker NO le saca nada: es un módulo nuevo, no uno que perdiera.
    const sumados: Record<string, string[]> = {
      broker: ['liquidity_pool'],
      company: ['liquidity_pool', 'hedge_fund'],
    };
    for (const [model, bloqueadosAntes] of Object.entries(antes)) {
      expect(new Set(blockedModules(model))).toEqual(
        new Set([...bloqueadosAntes, ...sumados[model]]),
      );
    }
    expect(uploadSections('broker')).toEqual([
      'depositos', 'retiros', 'egresos', 'ingresos', 'liquidez', 'inversiones',
    ]);
    expect(uploadSections('company')).toEqual(['ingresos', 'egresos']);
    expect(moduleAllowedForModel('broker', 'upload')).toBe(true);
    expect(moduleAllowedForModel('company', 'upload')).toBe(true);
    expect(blockedReportSections('broker')).toEqual([]);
  });

  it('la base CAJA de egresos sigue siendo exclusiva de company', () => {
    // §2.2: aplicar caja donde no se carga `paid` infla la base distribuible.
    expect(features('company').cashBasisExpenses).toBe(true);
    expect(features('broker').cashBasisExpenses).toBe(false);
    expect(features('liquidity_provider').cashBasisExpenses).toBe(false);
  });
});
