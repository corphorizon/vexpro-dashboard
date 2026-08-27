import { describe, it, expect } from 'vitest';
import { classifyAssetClass, ASSET_CLASSES, SYNTHETIC_SYMBOL_PATTERNS, isAssetClass } from './asset-class';

// Las listas de abajo NO son inventadas: son el universo COMPLETO de símbolos
// que aparecen en `ibrewards` de Vex Pro (168 distintos, 11.829.132 premios,
// ventana 2026-08-13 → 2026-08-27, medido el 2026-08-27). Se contrastaron
// contra el grupo de la cuenta: cero contradicciones — ningún símbolo de esta
// lista de forex aparece jamás bajo un grupo `Synthetics*`, y todos los de la
// lista de sintéticos aparecen bajo alguno.

const SINTETICOS_REALES = [
  'Boom 300 Index', 'Boom 500 Index', 'Boom 600 Index', 'Boom 900 Index', 'Boom 1000 Index',
  'Crash 300 Index', 'Crash 500 Index', 'Crash 600 Index', 'Crash 900 Index', 'Crash 1000 Index',
  'Step Index', 'Step Index 200', 'Step Index 300', 'Step Index 400', 'Step Index 500',
  'Volatility 10 Index', 'Volatility 25 Index', 'Volatility 50 Index', 'Volatility 75 Index',
  'Volatility 100 Index', 'Volatility 10 (1s) Index', 'Volatility 15 (1s) Index',
  'Volatility 25 (1s) Index', 'Volatility 30 (1s) Index', 'Volatility 50 (1s) Index',
  'Volatility 75 (1s) Index', 'Volatility 90 (1s) Index', 'Volatility 100 (1s) Index',
  'Volatility 150 (1s) Index',
  'GainX 400', 'GainX 600', 'GainX 800', 'GainX 999', 'GainX 1200',
  'PainX 400', 'PainX 600', 'PainX 800', 'PainX 999', 'PainX 1200',
  'TrendX 600', 'TrendX 1200', 'TrendX 1800',
  'SwitchX 600', 'SwitchX 1200', 'SwitchX 1800',
  'FlipX 1', 'FlipX 2', 'FlipX 3', 'FlipX 4', 'FlipX 5', 'BreakX 600',
  'Jump 10 Index', 'Jump 25 Index', 'Jump 50 Index', 'Jump 75 Index',
  'DEX 600 UP Index', 'DEX 600 DOWN Index', 'DEX 900 UP Index', 'DEX 900 DOWN Index',
  'DEX 1500 UP Index', 'DEX 1500 DOWN Index',
  'FX Vol 20', 'FX Vol 40', 'FX Vol 60', 'FX Vol 80', 'FX Vol 99',
  'SFX Vol 20', 'SFX Vol 40', 'SFX Vol 60', 'SFX Vol 80', 'SFX Vol 99',
];

const FOREX_CFD_REALES = [
  'XAUUSD.', 'XAUUSD', 'XAUUSD!', 'XAUUSD.vip2', 'XAUUSD.pro', 'XAUUSD.elt', 'XAUUSD.7x', 'XAUUSD.prm',
  'XAGUSD.', 'XAUEUR.', 'XTIUSD.', 'XBRUSD.',
  'EURUSD', 'EURUSD.', 'EURUSD!', 'EURUSD.pro', 'EURUSD.elt', 'EURUSD.vip2', 'EURUSD.7x',
  'GBPUSD', 'GBPUSD.', 'GBPUSD.elt', 'USDJPY.', 'USDJPY.pro', 'USDJPY.elt', 'USDCHF.pro',
  'USDCAD', 'USDCAD.', 'USDCAD.elt', 'USDCAD.vip2', 'USDMXN.',
  'AUDCAD.', 'AUDCAD!', 'AUDCHF', 'AUDCHF.', 'AUDJPY', 'AUDJPY.', 'AUDJPY!', 'AUDJPY.elt',
  'AUDNZD', 'AUDNZD.', 'AUDUSD.', 'AUDUSD!', 'CADJPY', 'CADJPY.', 'CADJPY.elt',
  'EURAUD', 'EURAUD.', 'EURAUD!', 'EURCAD.', 'EURCAD.elt', 'EURCHF.', 'EURGBP.', 'EURJPY.',
  'EURNZD.', 'EURNZD!', 'GBPCAD.', 'GBPCAD.pro', 'GBPJPY.', 'GBPJPY.pro', 'GBPJPY.elt', 'GBPNZD',
  'NZDCAD.', 'NZDJPY!', 'NZDUSD.', 'NZDUSD!', 'NZDUSD.pro',
  'NAS100', 'NAS100.', 'NAS100!', 'NAS100.pro', 'NAS100.elt', 'NAS100.vip2', 'NAS100.7x',
  'US30', 'US30.', 'US30!', 'US30.pro', 'US30.elt', 'US30.vip2',
  'SP500', 'SP500.', 'SP500!', 'SP500.pro', 'SP500.elt', 'SP500.vip2',
  'GER40.', 'JPN225.', 'JPN225!', 'UK100.', 'AUS200.',
  'BTCUSD', 'BTCUSDz', 'ETHUSD', 'ETHUSDz', 'BCHUSD', 'LTCUSD',
];

describe('classifyAssetClass', () => {
  it('clasifica como sintético el universo sintético real de Vex Pro', () => {
    for (const s of SINTETICOS_REALES) {
      expect(classifyAssetClass(s), s).toBe('synthetic');
    }
  });

  it('clasifica como forex/CFD el resto del universo real de Vex Pro', () => {
    for (const s of FOREX_CFD_REALES) {
      expect(classifyAssetClass(s), s).toBe('forex');
    }
  });

  it('cubre los 168 símbolos medidos entre las dos listas', () => {
    expect(SINTETICOS_REALES.length + FOREX_CFD_REALES.length).toBe(168);
    expect(new Set([...SINTETICOS_REALES, ...FOREX_CFD_REALES]).size).toBe(168);
  });

  // La trampa que motiva el anclaje al comienzo del nombre: "FX Vol 20" lleva
  // FX y es sintético; "FlipX" lleva X y es sintético; ningún par de divisas
  // debe caer del lado sintético por contener esas letras.
  it('no confunde "FX Vol" con forex ni los pares de divisas con sintéticos', () => {
    expect(classifyAssetClass('FX Vol 20')).toBe('synthetic');
    expect(classifyAssetClass('SFX Vol 99')).toBe('synthetic');
    expect(classifyAssetClass('EURUSD')).toBe('forex');
    expect(classifyAssetClass('USDCHF.pro')).toBe('forex');
  });

  it('es insensible a mayúsculas y a espacios de más', () => {
    expect(classifyAssetClass('  boom 500 index  ')).toBe('synthetic');
    expect(classifyAssetClass('VOLATILITY 75 INDEX')).toBe('synthetic');
    expect(classifyAssetClass('  xauusd.  ')).toBe('forex');
  });

  // Un símbolo desconocido cae en forex/CFD a propósito: es la clase por
  // defecto. Lo que NO puede pasar es que devuelva null y el llamador invente
  // un tercer caso — "sin dato" en esta casa significa "el mes no está
  // cubierto por el espejo", no "no reconozco el símbolo".
  it('lo desconocido, lo vacío y lo nulo caen en forex/CFD', () => {
    expect(classifyAssetClass('SIMBOLO_QUE_NO_EXISTE')).toBe('forex');
    expect(classifyAssetClass('')).toBe('forex');
    expect(classifyAssetClass(null)).toBe('forex');
    expect(classifyAssetClass(undefined)).toBe('forex');
  });

  it('reconoce las familias hermanas todavía no vistas en los datos', () => {
    expect(classifyAssetClass('Range Break 100 Index')).toBe('synthetic');
    expect(classifyAssetClass('Drift Switch Index 10')).toBe('synthetic');
    expect(classifyAssetClass('Bear Market Index')).toBe('synthetic');
    expect(classifyAssetClass('Bull Market Index')).toBe('synthetic');
    expect(classifyAssetClass('Multi Step 2 Index')).toBe('synthetic');
  });

  it('los patrones no llevan la bandera global (`lastIndex` haría fallar la segunda llamada)', () => {
    for (const re of SYNTHETIC_SYMBOL_PATTERNS) expect(re.global).toBe(false);
    expect(classifyAssetClass('Boom 500 Index')).toBe('synthetic');
    expect(classifyAssetClass('Boom 500 Index')).toBe('synthetic');
  });

  it('isAssetClass sólo acepta las dos clases', () => {
    for (const c of ASSET_CLASSES) expect(isAssetClass(c)).toBe(true);
    expect(isAssetClass('crypto')).toBe(false);
    expect(isAssetClass(null)).toBe(false);
  });
});
