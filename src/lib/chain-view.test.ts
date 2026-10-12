// chain-view: estado de la serie del CRM → badge/banner, y totales de 1..N
// meses que nunca convierten «no lo sabemos» en 0 (reglas §1.3).
import { describe, it, expect } from 'vitest';
import { seriesState, sumChain, worstSeriesState, type ChainEntryLike } from './chain-view';
import type { AutoSeriesStatusMap } from './distribution-inputs';

const READY: AutoSeriesStatusMap = { brokerPnl: 'ready', crmMonthly: 'ready' };
const LOADING: AutoSeriesStatusMap = { brokerPnl: 'loading', crmMonthly: 'ready' };

const entry = (over: Partial<ChainEntryLike> = {}): ChainEntryLike => ({
  ingresosNetos: 1000,
  egresosNetos: 400,
  saldoAFavor: 600,
  reserveThisPeriod: 60,
  montoDistribuir: 540,
  incompleto: [],
  incompletoEstado: null,
  heredaIncompleto: false,
  pendiente: false,
  ...over,
});

const ownLoading = entry({ incompleto: ['brokerPnl'], incompletoEstado: 'loading', pendiente: true });
const ownFailed = entry({ incompleto: ['propFirm'], incompletoEstado: 'failed', pendiente: true });
const inherited = entry({ heredaIncompleto: true, pendiente: true });

describe('seriesState — estado de la serie → badge y banner', () => {
  it('período completo: sin estado', () => {
    expect(seriesState(entry(), READY)).toBeNull();
    expect(seriesState(null, READY)).toBeNull();
    expect(seriesState(undefined)).toBeNull();
  });

  it('cargando: badge stale, banner stale, el texto de pendingValueLabel', () => {
    expect(seriesState(ownLoading, LOADING)).toEqual({
      phase: 'loading',
      label: 'Cargando datos del CRM…',
      badge: 'stale',
      notice: 'stale',
    });
  });

  it('falló: badge stale (el dato existe, no llegó) pero banner bad (informe incompleto)', () => {
    expect(seriesState(ownFailed, READY)).toEqual({
      phase: 'failed',
      label: 'Sin datos del CRM',
      badge: 'stale',
      notice: 'bad',
    });
  });

  it('heredado: cuenta para la cadena, no para ingresos/resultado del mes', () => {
    expect(seriesState(inherited, READY, 'own')).toBeNull();
    expect(seriesState(inherited, READY, 'chain')?.phase).toBe('failed');
    // Mientras alguna serie viaja, lo heredado está cargando, no fallado.
    expect(seriesState(inherited, LOADING, 'chain')).toMatchObject({ phase: 'loading', notice: 'stale' });
    // Sin el mapa de estados no se puede afirmar que carga: falla.
    expect(seriesState(inherited, undefined, 'chain')?.phase).toBe('failed');
  });

  it('propio gana sobre heredado (el estado es el de la serie del mes)', () => {
    const both = entry({ incompleto: ['brokerPnl'], incompletoEstado: 'loading', heredaIncompleto: true, pendiente: true });
    expect(seriesState(both, READY, 'chain')?.phase).toBe('loading');
  });
});

describe('worstSeriesState', () => {
  it('failed pesa más que loading; null se ignora', () => {
    const l = seriesState(ownLoading, LOADING);
    const f = seriesState(ownFailed, READY);
    expect(worstSeriesState([l, null, f])?.phase).toBe('failed');
    expect(worstSeriesState([f, l])?.phase).toBe('failed');
    expect(worstSeriesState([null, l])?.phase).toBe('loading');
    expect(worstSeriesState([])).toBeNull();
  });
});

describe('sumChain — totales de 1..N meses', () => {
  it('un período completo: sus números tal cual', () => {
    expect(sumChain([entry()], READY)).toMatchObject({
      ingresosNetos: 1000,
      egresosNetos: 400,
      resultado: 600,
      reserva: 60,
      aDistribuir: 540,
      ownState: null,
      chainState: null,
      pendingCount: 0,
      missingCount: 0,
    });
  });

  it('consolidado: suma redondeada a centavos', () => {
    const r = sumChain([entry({ ingresosNetos: 0.1 }), entry({ ingresosNetos: 0.2 })], READY);
    expect(r.ingresosNetos).toBe(0.3);
    expect(r.egresosNetos).toBe(800);
    expect(r.aDistribuir).toBe(1080);
  });

  it('un mes con su serie faltante: ingresos/resultado/reserva/a distribuir null; egresos se saben', () => {
    const r = sumChain([entry(), ownLoading], LOADING);
    expect(r.ingresosNetos).toBeNull();
    expect(r.resultado).toBeNull();
    expect(r.reserva).toBeNull();
    expect(r.aDistribuir).toBeNull();
    expect(r.egresosNetos).toBe(800);
    expect(r.ownState?.phase).toBe('loading');
    expect(r.pendingCount).toBe(1);
  });

  it('heredado: ingresos y resultado SÍ son definitivos; reserva y a distribuir no', () => {
    const r = sumChain([inherited], READY);
    expect(r.ingresosNetos).toBe(1000);
    expect(r.resultado).toBe(600);
    expect(r.reserva).toBeNull();
    expect(r.aDistribuir).toBeNull();
    expect(r.ownState).toBeNull();
    expect(r.chainState?.notice).toBe('bad');
  });

  it('un período que no está en la cadena hace null todo (no se suma lo que no se encontró)', () => {
    const r = sumChain([entry(), undefined], READY);
    expect(r).toMatchObject({ ingresosNetos: null, egresosNetos: null, resultado: null, aDistribuir: null, missingCount: 1 });
  });

  it('sin períodos: nada es cero, todo es null', () => {
    const r = sumChain([], READY);
    expect(r.ingresosNetos).toBeNull();
    expect(r.egresosNetos).toBeNull();
    expect(r.aDistribuir).toBeNull();
  });

  it('un mes negativo con a distribuir 0 es un cero DE VERDAD (definitivo), no null', () => {
    const r = sumChain([entry({ saldoAFavor: -200, reserveThisPeriod: 0, montoDistribuir: 0 })], READY);
    expect(r.resultado).toBe(-200);
    expect(r.aDistribuir).toBe(0);
  });
});
