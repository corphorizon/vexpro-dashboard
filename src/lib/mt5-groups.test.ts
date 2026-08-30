import { describe, it, expect } from 'vitest';
import { esGrupoDemo, esCuentaDemoCrm } from './mt5-groups';

describe('esGrupoDemo', () => {
  it('reconoce los grupos demo reales de Vex Pro', () => {
    // Los ocho grupos demo medidos el 2026-08-28, 2.290 cuentas en total.
    for (const g of [
      'demo\\Broker\\Synthetics',
      'demo\\Broker\\STP',
      'demo\\Broker\\ECN',
      'demo\\PropFirm\\Vex2ProForex_Challenge_1',
      'demo\\PropFirm\\Vex2ProSynthetics_Challenge_1',
      'demo\\Broker\\Register_auto',
      'demo\\PropFirm\\Vex2ProForex_Challenge_2',
      'demo\\forex-hedge-usd-01',
    ]) {
      expect(esGrupoDemo(g)).toBe(true);
    }
  });

  it('NO marca las reales, ni las que sólo contienen la palabra', () => {
    for (const g of [
      'real\\Broker\\Synthetics',
      'real\\Cent\\STP',
      'real\\PropFirm\\LeverageX12',
      'real\\Copy\\Investor_Synthetics',
      // El prefijo es lo que manda: un grupo real con «demo» en el medio no es
      // una demo. Buscar la palabra en cualquier posición marcaría cuentas con
      // dinero real, que es el error caro de los dos.
      'real\\Broker\\demo_migrados',
    ]) {
      expect(esGrupoDemo(g)).toBe(false);
    }
  });

  it('un grupo desconocido NO es demo', () => {
    // «No sabemos el grupo» no es «es demo». Excluir por las dudas escondería
    // cuentas reales sin dejar rastro.
    expect(esGrupoDemo(null)).toBe(false);
    expect(esGrupoDemo(undefined)).toBe(false);
    expect(esGrupoDemo('')).toBe(false);
    expect(esGrupoDemo('   ')).toBe(false);
  });

  it('no depende de mayúsculas ni de espacios al borde', () => {
    expect(esGrupoDemo('DEMO\\Broker\\STP')).toBe(true);
    expect(esGrupoDemo('  demo\\Broker\\STP  ')).toBe(true);
  });
});

describe('esCuentaDemoCrm', () => {
  it('usa is_live, no el nombre del grupo', () => {
    expect(esCuentaDemoCrm({ is_live: false })).toBe(true);
    expect(esCuentaDemoCrm({ is_live: true })).toBe(false);
  });

  it('is_live desconocido NO es demo', () => {
    expect(esCuentaDemoCrm({ is_live: null })).toBe(false);
    expect(esCuentaDemoCrm({})).toBe(false);
  });
});

describe('la trampa que costó un despliegue', () => {
  it('el group_name del CRM NO sirve para decidir si es demo', () => {
    // La cuenta 149426 es `demo\Broker\Synthetics` en MT5 y `SYNTHETICS` a
    // secas en el CRM. Aplicarle la regla de MT5 al nombre del CRM no da
    // error: devuelve `false` para TODAS y deja pasar las demo enteras.
    //
    // Este test existe para que el próximo que quiera filtrar demo desde una
    // tabla del CRM se encuentre con el motivo escrito.
    const groupNameDelCrm = 'SYNTHETICS'; // la cuenta ES demo
    expect(esGrupoDemo(groupNameDelCrm)).toBe(false);
    expect(esCuentaDemoCrm({ is_live: false })).toBe(true);
  });
});
