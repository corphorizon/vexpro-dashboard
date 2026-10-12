// Humo: la muestra de primitivas renderiza entera (claro + oscuro) sin tirar.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { DesignShowcase } from './showcase';
import { text, html } from '@/test/render';

describe('/_design', () => {
  it('renderiza todas las primitivas en los dos temas', () => {
    const out = html(createElement(DesignShowcase));
    expect(out).toContain('class="dark ');
    expect(out.match(/role="img"/g)).toHaveLength(2);
    const t = text(createElement(DesignShowcase));
    expect(t).toContain('Mostrando 5 de 1,284');
    expect(t).toContain('Total (7 de 8 canales)');
    expect(t).not.toContain('$NaN');
  });
});
