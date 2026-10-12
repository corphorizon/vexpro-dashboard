// ChannelBalancesCard renderizada (SSR, como las primitivas): KPIs, banners
// con nombres y cifra, grupos por tipo, deuda con signo, pie con el conteo.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { html, text } from '@/test/render';
import type { ChannelConfigRow, ResolvedChannel } from '@/lib/channel-configs';
import { ChannelBalancesCard } from './channel-balances-card';
import type { BalanceMeta } from './balances-view';

const ch = (key: string, label: string, sortOrder: number): ResolvedChannel => ({
  key,
  label,
  type: 'manual',
  description: '',
  isVisible: true,
  isBuiltin: false,
  isCustom: true,
  sortOrder,
});

const CHANNELS = [ch('coinsbuy', 'Coinsbuy', 1), ch('banco', 'Banco X', 2), ch('kraken', 'Kraken', 3), ch('socio', 'Préstamo socio', 4)];
const CONFIG = [
  { channel_key: 'banco', location_type: 'bank' },
  { channel_key: 'kraken', location_type: 'trading' },
  { channel_key: 'socio', location_type: 'debt', holder: 'Kevin' },
] as unknown as ChannelConfigRow[];
const VALUES: Record<string, number> = { coinsbuy: 600, banco: 400, kraken: 0, socio: 250 };
const META: Record<string, BalanceMeta> = {
  coinsbuy: { source: 'live', asOf: null, degraded: false, stale: false },
  banco: { source: 'ledger', asOf: '2026-08-01', degraded: false, stale: true },
  kraken: { source: 'missing', asOf: null, degraded: false, stale: false },
  socio: { source: 'ledger', asOf: '2026-10-01', degraded: false, stale: false },
};

function render() {
  return createElement(ChannelBalancesCard, {
    channels: CHANNELS,
    hiddenChannels: ['Wallet vieja'],
    configRows: CONFIG,
    getValue: (k: string) => VALUES[k] ?? 0,
    onChanged: () => {},
    canManage: false,
    selectedDate: '2026-10-12',
    getBalanceMeta: (k: string) => META[k],
  });
}

describe('<ChannelBalancesCard>', () => {
  const out = text(render());
  const markup = html(render());

  it('Total neto es el hero = disponible + prestado − deuda', () => {
    expect(markup).toContain('data-hero="true"');
    expect(out).toContain('Total neto');
    expect(out).toContain('$750.00'); // 600 + 400 + 0 − 250
    expect(out).toContain('Deuda con terceros');
  });

  it('banner stale con nombre y monto que sigue sumando; banner pend para el sin dato', () => {
    expect(out).toContain('1 canal desactualizado');
    expect(out).toContain('Sigue sumando al total con dato viejo: $400.00 (Banco X).');
    expect(out).toContain('1 canal sin dato');
    expect(markup).toContain('data-kind="stale"');
    expect(markup).toContain('data-kind="pend"');
  });

  it('grupos por tipo, deuda en negativo, sin dato como «—»', () => {
    expect(out).toContain('Pasarelas');
    expect(out).toContain('Bancos, exchanges y efectivo');
    expect(out).toContain('Deudas');
    expect(out).toContain('-$250.00');
    expect(markup).toMatch(/Kraken[\s\S]*?Sin dato/);
  });

  it('pie: N sumados, M excluidos (sin dato + ocultos) y nombra los ocultos', () => {
    expect(out).toContain('3 canales sumados, 2 excluidos');
    expect(out).toContain('Ocultos desde Configurar (no suman): Wallet vieja.');
  });

  it('sin paleta cruda ni dark: de color', () => {
    expect(markup).not.toMatch(/(text|bg|border)-(red|emerald|green|orange|amber|blue)-\d/);
    expect(markup).not.toMatch(/dark:(text|bg|border)-/);
  });
});
