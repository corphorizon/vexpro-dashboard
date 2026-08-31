import { describe, it, expect } from 'vitest';
import {
  REPORT_SECTIONS,
  REPORT_SECTION_KEYS,
  REPORT_SECTION_COLUMNS,
  allSectionsOn,
  allSectionsOff,
  onlySections,
  isReportSectionKey,
  parseReportSections,
  reportSectionLabel,
  reportSectionLabels,
} from './sections';
import { DEFAULT_REPORT_CONFIG } from './config';
import { blockedReportSections } from '@/lib/business-model';

describe('registro de secciones del reporte', () => {
  it('tiene las cinco de siempre, en orden', () => {
    expect(REPORT_SECTION_KEYS).toEqual([
      'deposits_withdrawals',
      'balances_by_channel',
      'crm_users',
      'broker_pnl',
      'prop_trading',
    ]);
  });

  it('la columna de cada sección es `include_<clave>`', () => {
    // Es el contrato con `report_configs` (migración 034). Si alguien agrega
    // una sección con otro nombre de columna, este test lo obliga a decidirlo a
    // conciencia en vez de que el upsert escriba a una columna que no existe.
    for (const s of REPORT_SECTIONS) {
      expect(s.column).toBe(`include_${s.key}`);
    }
    expect(REPORT_SECTION_COLUMNS).toHaveLength(REPORT_SECTION_KEYS.length);
  });

  it('cada sección tiene etiqueta en los dos idiomas y ninguna repetida', () => {
    const es = REPORT_SECTIONS.map((s) => s.labelEs);
    const en = REPORT_SECTIONS.map((s) => s.labelEn);
    expect(es.every(Boolean)).toBe(true);
    expect(en.every(Boolean)).toBe(true);
    expect(new Set(es).size).toBe(es.length);
    expect(new Set(en).size).toBe(en.length);
  });

  it('el default de la config es "todo encendido"', () => {
    // Una fila ausente en `report_configs` significa "no configuró nada", y eso
    // es todo prendido: agregar la tabla no puede apagarle secciones a nadie.
    expect(DEFAULT_REPORT_CONFIG.sections).toEqual(allSectionsOn());
    expect(Object.values(allSectionsOn()).every((v) => v === true)).toBe(true);
    expect(Object.values(allSectionsOff()).every((v) => v === false)).toBe(true);
  });

  it('onlySections prende sólo lo pedido', () => {
    const only = onlySections(['broker_pnl']);
    expect(only.broker_pnl).toBe(true);
    expect(only.deposits_withdrawals).toBe(false);
  });
});

describe('parseReportSections', () => {
  it('toma del body sólo lo que vino como booleano', () => {
    const stored = allSectionsOn();
    const parsed = parseReportSections(
      { deposits_withdrawals: false, crm_users: 'sí', broker_pnl: undefined },
      stored,
    );
    expect(parsed.deposits_withdrawals).toBe(false); // vino booleano
    expect(parsed.crm_users).toBe(true); // string → fallback
    expect(parsed.broker_pnl).toBe(true); // undefined → fallback
    expect(parsed.prop_trading).toBe(true); // ausente → fallback
  });

  it('cubre TODAS las secciones aunque el body sea basura', () => {
    // El bug que esto evita: cinco ternarios copiados y una sección nueva
    // olvidada, que salía siempre con el valor guardado aunque el usuario la
    // hubiera destildado en el modal.
    for (const raw of [null, undefined, 42, 'x', []]) {
      const parsed = parseReportSections(raw, allSectionsOff());
      expect(Object.keys(parsed).sort()).toEqual([...REPORT_SECTION_KEYS].sort());
    }
  });
});

describe('blockedReportSections apunta a claves REALES', () => {
  it('todo lo que el modelo bloquea existe en el registro', () => {
    // Acá se empujaban cadenas sueltas y `loadReportConfig` las aplicaba con
    // `if (key in sections)`: un typo no apagaba nada y no fallaba en ningún
    // lado. Ahora ni siquiera compila, y este test lo fija para los datos.
    for (const model of ['broker', 'company', 'both', null, undefined, 'lo-que-sea']) {
      for (const key of blockedReportSections(model)) {
        expect(isReportSectionKey(key), `${String(model)} → ${key}`).toBe(true);
      }
    }
  });

  it('una consultora no recibe las secciones del bróker', () => {
    const blocked = blockedReportSections('company');
    expect(blocked).toContain('deposits_withdrawals');
    expect(blocked).toContain('broker_pnl');
    expect(blocked).toContain('prop_trading');
    expect(blocked).toContain('crm_users');
  });
});

describe('etiquetas', () => {
  it('traduce, y una clave desconocida vuelve tal cual', () => {
    expect(reportSectionLabel('broker_pnl', 'es')).toBe('P&L Broker');
    expect(reportSectionLabel('broker_pnl', 'en')).toBe('Broker P&L');
    expect(reportSectionLabels('en').crm_users).toBe('CRM users');
    expect(reportSectionLabels('es').crm_users).toBe('Usuarios CRM');
  });

  it('el mapa de etiquetas cubre todas las secciones', () => {
    // El panel y el modal renderizan `Object.keys(SECTION_LABELS)`: si el mapa
    // no está completo, la sección desaparece del formulario sin fallar.
    expect(Object.keys(reportSectionLabels('es')).sort()).toEqual(
      [...REPORT_SECTION_KEYS].sort(),
    );
  });
});
