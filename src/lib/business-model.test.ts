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
import { blockedReportSections } from './business-model';
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

  it('un broker conserva TODO lo que tenía', () => {
    const f = features('broker');
    expect(f).toEqual({
      deposits: true, withdrawals: true, netDeposit: true, brokerPnl: true,
      movements: true, liquidity: true, investments: true, incomeLines: true,
      riskManagement: true, commercialTeam: true,
    });
    expect(blockedModules('broker')).toEqual([]);
  });

  it('una empresa de servicios no tiene depósitos, retiros ni riesgo', () => {
    const f = features('company');
    expect(f.deposits).toBe(false);
    expect(f.withdrawals).toBe(false);
    expect(f.netDeposit).toBe(false);
    expect(f.riskManagement).toBe(false);
    expect(f.movements).toBe(false);
    expect(f.liquidity).toBe(false);
    expect(f.investments).toBe(false);
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
    expect(defaultUploadSection('company')).toBe('ingresos');
  });

  it('ningún modelo se queda sin pestañas', () => {
    for (const m of BUSINESS_MODELS) expect(uploadSections(m).length).toBeGreaterThan(0);
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
