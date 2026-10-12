// Panel, Notice, Field, Segmented y Chip: render + comportamiento.
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { Panel } from './panel';
import { Notice, type NoticeKind } from './notice';
import { Field, Input, Select, Textarea, type FieldProps } from './field';
import { Segmented } from './segmented';
import { Chip } from './chip';
import { findElements, html } from '@/test/render';

describe('<Panel>', () => {
  it('borde, shadow-1, rounded-ui-lg, h2 15/600 y hint text-3', () => {
    const out = html(createElement(Panel, { title: 'Saldos', hint: 'por canal', actions: 'X' }, 'cuerpo'));
    expect(out).toContain('rounded-ui-lg border border-border bg-card shadow-1');
    expect(out).toMatch(/<h2 class="text-\[15px\] font-semibold/);
    expect(out).toContain('text-[12.5px] leading-4 text-text-3');
    expect(out).toContain('min-h-12');
    expect(out).toContain('<div class="p-4">cuerpo</div>');
  });
  it('flush: cuerpo sin padding (para tablas); pie con borde superior', () => {
    const out = html(createElement(Panel, { title: 'T', flush: true, footer: 'Mostrando 21 de 1.284' }, 'tabla'));
    expect(out).toContain('<div class="">tabla</div>');
    expect(out).toContain('<footer class="border-t border-border');
    expect(out).toContain('Mostrando 21 de 1.284');
  });
  it('sin título ni acciones no dibuja cabecera vacía', () => {
    expect(html(createElement(Panel, null, 'x'))).not.toContain('<header');
  });
});

describe('<Notice>', () => {
  const kinds: NoticeKind[] = ['stale', 'pend', 'info', 'bad'];
  it('fondo *-bg, borde del color al 35 %, ícono del color', () => {
    const map = { stale: 'stale', pend: 'pend', info: 'info', bad: 'neg' } as const;
    for (const k of kinds) {
      const out = html(createElement(Notice, { kind: k, title: 'T' }, 'detalle'));
      expect(out, k).toContain(`bg-${map[k]}-bg border-${map[k]}/35`);
      expect(out, k).toContain(`text-${map[k]}`);
      expect(out, k).not.toMatch(/dark:|-(red|amber|emerald)-\d/);
    }
  });
  it('bad es alert; el resto status', () => {
    expect(html(createElement(Notice, { kind: 'bad', title: 'T' }))).toContain('role="alert"');
    expect(html(createElement(Notice, { kind: 'stale', title: 'T' }))).toContain('role="status"');
  });
  it('muestra título, detalle y acción', () => {
    const out = html(
      createElement(Notice, { kind: 'pend', title: 'Binance sin dato', action: createElement('a', { href: '#' }, 'Revisar') }, 'no está sumado'),
    );
    expect(out).toContain('Binance sin dato');
    expect(out).toContain('no está sumado');
    expect(out).toContain('Revisar');
  });
});

// children como 3er argumento (react/no-children-prop); el cast es porque
// FieldProps declara children obligatorio.
const field = (p: Omit<FieldProps, 'children'>, child: ReactElement) => createElement(Field, p as FieldProps, child);

describe('<Field>', () => {
  it('label visible atado al control por id; alto 36; borde control-border', () => {
    const out = html(field({ label: 'Monto', hint: 'En USD' }, createElement(Input)));
    const id = out.match(/<label for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain('h-9');
    expect(out).toContain('border-control-border');
    expect(out).toContain(`aria-describedby="${id}-hint"`);
  });
  it('error: aria-invalid, borde neg, mensaje con ícono, descrito antes que el hint', () => {
    const out = html(field({ label: 'Monto', hint: 'En USD', error: 'Usá punto' }, createElement(Input)));
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('border-neg');
    expect(out).not.toContain('border-control-border');
    expect(out).toMatch(/text-neg"><svg/);
    expect(out).toMatch(/aria-describedby="[^"]+-error [^"]+-hint"/);
  });
  it('required: asterisco + «obligatorio» para lectores, y required en el control', () => {
    const out = html(field({ label: 'Concepto', required: true }, createElement(Input)));
    expect(out).toContain('(obligatorio)');
    expect(out).toContain('required=""');
  });
  it('Select y Textarea usan el mismo cableado y la misma receta (sin focus:ring propio)', () => {
    const sel = html(field({ label: 'Canal' }, createElement(Select, null, createElement('option', null, 'A'))));
    const ta = html(field({ label: 'Nota' }, createElement(Textarea)));
    for (const out of [sel, ta]) {
      expect(out).toMatch(/<label for="([^"]+)"[\s\S]*id="\1"/);
      expect(out).toContain('border-control-border');
      expect(out).not.toMatch(/focus:ring|focus:outline-none/);
    }
  });
});

// Segmented y Chip no usan hooks: se llaman como función para obtener el
// árbol y disparar los handlers sin DOM.
describe('<Segmented>', () => {
  const props = {
    'aria-label': 'Vista',
    value: 'all' as const,
    onChange: vi.fn(),
    options: [
      { value: 'all' as const, label: 'Todos', count: 8 },
      { value: 'in' as const, label: 'Entradas', count: null },
    ],
  };
  it('grupo con nombre, aria-pressed en cada botón, 26 px, activo con superficie + shadow-1', () => {
    const out = html(createElement(Segmented<'all' | 'in'>, props));
    expect(out).toContain('role="group" aria-label="Vista"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(out).toContain('h-[26px]');
    expect(out).toContain('bg-card font-semibold text-brand-ink shadow-[inset_0_-2px_0_0_var(--brand-ink),var(--shadow-1)]');
  });
  it('un conteo null no se muestra como 0', () => {
    const out = html(createElement(Segmented<'all' | 'in'>, props));
    expect(out).toContain('>8<');
    expect(out).not.toContain('>0<');
  });
  it('click llama onChange con el valor', () => {
    const onChange = vi.fn();
    const tree = Segmented<'all' | 'in'>({ ...props, onChange });
    const buttons = findElements(tree, (el) => el.type === 'button');
    (buttons[1].props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith('in');
  });
});

describe('<Chip>', () => {
  it('inactivo: borde punteado border-strong; aria-pressed=false', () => {
    const out = html(createElement(Chip, null, 'API'));
    expect(out).toContain('border-dashed border-border-strong');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('h-7');
    expect(out).toContain('rounded-full');
  });
  it('activo: borde sólido brand-ink, fondo brand-tint, 600', () => {
    const out = html(createElement(Chip, { active: true, count: 5 }, 'API'));
    expect(out).toContain('border-solid border-brand-ink bg-brand-tint font-semibold');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('>5<');
  });
  it('click dispara onClick (es un toggle, lo decide el llamador)', () => {
    const onClick = vi.fn();
    const render = (Chip as unknown as { render: (p: object, ref: null) => ReactElement }).render;
    const tree = render({ onClick, children: 'API' }, null);
    (tree.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
