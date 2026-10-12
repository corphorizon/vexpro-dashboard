// KpiStrip: sin dato → «—» + «Sin dato» (nunca $0), stale con «hace X», delta.
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { KpiStrip, deltaParts, kpiPlainText, type KpiItem } from './kpi-strip';
import { relativeAge } from './relative-age';
import { html, text } from '@/test/render';

const NOW = Date.parse('2026-10-12T15:00:00Z');
const H = 3_600_000;

describe('relativeAge', () => {
  it('elige la unidad con cortes en 1 min, 60 min y 48 h', () => {
    expect(relativeAge(NOW - 30_000, NOW)).toEqual({ key: 'ui.ago.now', n: 0 });
    expect(relativeAge(NOW - 4 * 60_000, NOW)).toEqual({ key: 'ui.ago.min', n: 4 });
    expect(relativeAge(NOW - 26 * H, NOW)).toEqual({ key: 'ui.ago.h', n: 26 });
    expect(relativeAge(NOW - 47.9 * H, NOW)).toEqual({ key: 'ui.ago.h', n: 47 });
    expect(relativeAge(NOW - 41 * 24 * H, NOW)).toEqual({ key: 'ui.ago.d', n: 41 });
  });
  it('acepta Date / ISO / epoch; futuro = recién; inválido = null', () => {
    expect(relativeAge(new Date(NOW - 2 * H), NOW)?.n).toBe(2);
    expect(relativeAge(new Date(NOW - 2 * H).toISOString(), NOW)?.n).toBe(2);
    expect(relativeAge(NOW + 5 * 60_000, NOW)?.key).toBe('ui.ago.now');
    expect(relativeAge('no es fecha', NOW)).toBeNull();
    expect(relativeAge(null, NOW)).toBeNull();
    expect(relativeAge('', NOW)).toBeNull();
  });
});

describe('deltaParts', () => {
  it('▲ en pos cuando sube y subir es bueno', () => {
    expect(deltaParts({ pct: 4.13 })).toEqual({ text: '▲ 4.1 %', tone: 'pos' });
  });
  it('▼ en neg cuando baja', () => {
    expect(deltaParts({ pct: -2.06 })).toEqual({ text: '▼ 2.1 %', tone: 'neg' });
  });
  it("goodWhen 'down' invierte el color (gastos)", () => {
    expect(deltaParts({ pct: 12.5, goodWhen: 'down' }).tone).toBe('neg');
    expect(deltaParts({ pct: -3, goodWhen: 'down' }).tone).toBe('pos');
  });
  it('lo que redondea a 0.0 no tiene flecha ni color; NaN es «—»', () => {
    expect(deltaParts({ pct: 0.04 })).toEqual({ text: '0.0 %', tone: 'neutral' });
    expect(deltaParts({ pct: NaN })).toEqual({ text: '—', tone: 'neutral' });
  });
});

describe('kpiPlainText', () => {
  it('conteo y porcentaje; null → «—»', () => {
    expect(kpiPlainText(1284, 'count')).toBe('1,284');
    expect(kpiPlainText(4.13, 'percent')).toBe('4.1 %');
    expect(kpiPlainText(null, 'count')).toBe('—');
    expect(kpiPlainText(0, 'count')).toBe('0');
  });
});

describe('<KpiStrip>', () => {
  const items: KpiItem[] = [
    { key: 'a', label: 'Disponible', value: 148_660.17, hero: true, delta: { pct: 4.1, ref: '31 ago' } },
    { key: 'b', label: 'UniPayment', value: null, sub: 'La API no respondió' },
    { key: 'c', label: 'FairPay', value: 12_904.1, staleAt: NOW - 26 * H },
  ];

  it('una superficie, no tarjetas: un solo borde + shadow-1 y divisores por sombra', () => {
    const out = html(createElement(KpiStrip, { items, now: NOW }));
    expect(out.match(/shadow-1/g)?.length).toBe(1);
    expect(out).toContain('rounded-ui-lg');
    expect(out).toContain('shadow-[-1px_0_0_0_var(--border),0_-1px_0_0_var(--border)]');
    expect(out).toContain('--kc:3');
  });

  it('un KPI sin dato muestra «—» y «Sin dato», NUNCA $0.00', () => {
    const out = text(createElement(KpiStrip, { items, now: NOW }));
    expect(out).toContain('Sin dato');
    expect(out).toContain('La API no respondió');
    expect(out).not.toContain('$0.00');
    expect(out).not.toContain('$0');
  });

  it('missingBadge reemplaza al «Sin dato» (un dato en vuelo no es «sin dato»); false lo saca', () => {
    const loading = text(
      createElement(KpiStrip, {
        items: [{ key: 'x', label: 'Ingresos', value: null, missingBadge: { kind: 'stale', label: 'Cargando datos del CRM…' } }],
        now: NOW,
      }),
    );
    expect(loading).toContain('Cargando datos del CRM…');
    expect(loading).not.toContain('Sin dato');
    expect(loading).toContain('—');
    const out = html(
      createElement(KpiStrip, { items: [{ key: 'x', label: 'Inversiones', value: null, missingBadge: false, sub: 'Sin movimientos' }], now: NOW }),
    );
    expect(out).not.toContain('data-kind=');
    expect(out).toContain('Sin movimientos');
    // Con valor, el badge no aparece aunque esté configurado.
    const withValue = text(
      createElement(KpiStrip, { items: [{ key: 'x', label: 'I', value: 5, missingBadge: { kind: 'stale', label: 'Cargando' } }], now: NOW }),
    );
    expect(withValue).not.toContain('Cargando');
  });

  it('stale: «hace 26 h» y valor marcado', () => {
    const out = html(createElement(KpiStrip, { items, now: NOW }));
    expect(out).toContain('hace 26 h');
    expect(out).toContain('decoration-stale');
  });

  it('hero ocupa toda la fila en móvil y va a 26 px', () => {
    const out = html(createElement(KpiStrip, { items, now: NOW }));
    expect(out).toContain('data-hero="true"');
    expect(out).toContain('max-sm:col-span-2');
    expect(out).toContain('sm:text-[26px]');
  });

  it('delta con flecha, color y referencia', () => {
    const out = html(createElement(KpiStrip, { items, now: NOW }));
    expect(out).toContain('▲ 4.1 %');
    expect(out).toContain('vs. 31 ago');
    expect(out).toContain('text-pos');
  });

  it('más de 5 KPIs: muestra 5 y lo AVISA (no recorta en silencio)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 6 }, (_, i) => ({ key: String(i), label: `K${i}`, value: i }));
    const out = text(createElement(KpiStrip, { items: many, now: NOW }));
    expect(out).toContain('K4');
    expect(out).not.toContain('K5');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
