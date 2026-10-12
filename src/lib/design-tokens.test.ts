// ─────────────────────────────────────────────────────────────────────────────
// Tokens «Libro mayor» (docs/diseno-libro-mayor.md) — lo que este test fija:
//   1. Los valores de globals.css son los de la maqueta aprobada (base.css).
//   2. Cada color de significado pasa AA (4,5:1) contra su fondo *-bg y contra
//      la superficie, en claro Y en oscuro. El contraste se midió en la maqueta;
//      acá se recalcula para que nadie «ajuste un tono» y lo rompa sin saberlo.
//   3. Ninguna clase con doble opacidad (`bg-positive/10/30`): Tailwind la
//      descarta sin avisar y el aviso queda SIN fondo. Había 20 (2026-10-12).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from './brand-color';
import { hexToRgb } from './brand';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** Contenido del primer bloque `selector {…}` de nivel superior. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no encuentro ${selector} en globals.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return css.slice(open + 1, close);
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = vars(block(':root'));
const dark = vars(block('.dark'));

const ratio = (a: string, b: string) => contrastRatio(hexToRgb(a), hexToRgb(b));

// Valores de design-opus/src/base.css, salvo:
//   · --brand-tint: deriva de la marca desde el 2026-10-12 (spec §10); se fija
//     el respaldo en brand-color.test.ts / brand-theme.test.ts.
//   · *-bg de los significados: más saturados desde el 2026-10-12 (pedido
//     «más color» de Kevin). La maqueta tenía #E6F4EE/#FCEBE9/#FCF1DF/#E8EFFC/
//     #EFEDF8 y #0F2A20/#331614/#30230B/#132443/#221E3A. El contraste de abajo
//     se recalcula con los nuevos.
const BASE_LIGHT: Record<string, string> = {
  '--surface-2': '#F0F2F5', '--surface-sunk': '#EBEEF2',
  '--border-strong': '#C9D0DA', '--control-border': '#8A94A3',
  '--text-2': '#465264',
  '--pos': '#047857', '--pos-bg': '#D7F0E4', '--neg': '#B42318', '--neg-bg': '#FADCD8',
  '--pend': '#A15C07', '--pend-bg': '#FCEED8', '--info-bg': '#DCE7FC',
  '--stale': '#6B5FA8', '--stale-bg': '#EBE8F8',
  '--row-hover': '#F3F5F8', '--row-selected': '#EEF3FB', '--group-row': '#F7F8FA',
  '--r-sm': '4px', '--r-md': '6px', '--r-lg': '10px', '--r-xl': '14px', '--row-h': '36px',
};
const BASE_DARK: Record<string, string> = {
  '--surface-2': '#172031', '--surface-sunk': '#0D121C',
  '--border-strong': '#33405A', '--control-border': '#5E6B82',
  '--text-2': '#AAB4C5',
  '--pos': '#3CCB8F', '--pos-bg': '#113524', '--neg': '#F97066', '--neg-bg': '#421B18',
  '--pend': '#F2B13A', '--pend-bg': '#3D2C0C', '--info-bg': '#18305C',
  '--stale': '#B3A6F0', '--stale-bg': '#2C2550',
  '--row-hover': '#151D2C', '--row-selected': '#16233A', '--group-row': '#0E141F',
};

describe('tokens «Libro mayor» = maqueta aprobada', () => {
  for (const [k, v] of Object.entries(BASE_LIGHT)) {
    it(`claro ${k} = ${v}`, () => expect(light[k]?.toUpperCase()).toBe(v.toUpperCase()));
  }
  for (const [k, v] of Object.entries(BASE_DARK)) {
    it(`oscuro ${k} = ${v}`, () => expect(dark[k]?.toUpperCase()).toBe(v.toUpperCase()));
  }

  it('text-3 es alias de muted-foreground (flipa solo con .dark)', () => {
    expect(light['--text-3']).toBe('var(--muted-foreground)');
    expect(dark['--text-3']).toBeUndefined();
  });

  it('no hay @media (prefers-color-scheme): el tema lo resuelve la clase .dark', () => {
    // theme-context.tsx resuelve «system» en JS. Un bloque @media daría tokens
    // oscuros a quien eligió «claro» con el sistema en oscuro.
    expect(css).not.toMatch(/@media\s*\(prefers-color-scheme[^)]*\)\s*\{/);
  });

  it('cada token nuevo está expuesto como utilidad de Tailwind', () => {
    const theme = css.slice(css.indexOf('@theme inline'));
    for (const name of [
      'surface-2', 'surface-sunk', 'border-strong', 'control-border', 'text-2', 'text-3',
      'brand-tint', 'pos', 'pos-bg', 'neg', 'neg-bg', 'pend', 'pend-bg', 'info-bg',
      'stale', 'stale-bg', 'row-hover', 'row-selected', 'group-row',
      // Color de marca (spec §10)
      'brand-wash', 'sidebar-bg', 'sidebar-fg', 'sidebar-muted', 'sidebar-hover', 'sidebar-border',
      'sidebar-accent', 'sidebar-active-bg', 'sidebar-plate', 'nav-finance', 'nav-hr', 'nav-risk', 'nav-config',
    ]) {
      expect(theme).toContain(`--color-${name}: var(--${name});`);
    }
    expect(theme).toContain('--spacing-row: var(--row-h);');
    for (const r of ['sm', 'md', 'lg', 'xl']) expect(theme).toContain(`--radius-ui-${r}: var(--r-${r});`);
    for (const s of ['1', '2', '3']) expect(theme).toContain(`--shadow-${s}: var(--shadow-${s});`);
  });
});

describe('contraste AA (4,5:1) de los colores con significado', () => {
  const SIGNIFICADOS = ['pos', 'neg', 'pend', 'stale'] as const;
  const temas = [
    // Superficie de la maqueta y, en oscuro, también la tarjeta legada
    // (#1E293B) sobre la que estos tokens van a caer hasta la fase 3.
    { nombre: 'claro', v: light, superficies: ['#FFFFFF', light['--surface-2']] },
    { nombre: 'oscuro', v: dark, superficies: ['#111723', dark['--card'], dark['--surface-2']] },
  ];
  for (const { nombre, v, superficies } of temas) {
    for (const s of SIGNIFICADOS) {
      it(`${nombre}: --${s} sobre --${s}-bg`, () => {
        expect(ratio(v[`--${s}`], v[`--${s}-bg`])).toBeGreaterThanOrEqual(4.5);
      });
      for (const sup of superficies) {
        it(`${nombre}: --${s} sobre ${sup}`, () => {
          expect(ratio(v[`--${s}`], sup)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${nombre}: --info sobre --info-bg`, () => {
      expect(ratio(v['--info'], v['--info-bg'])).toBeGreaterThanOrEqual(4.5);
    });
    it(`${nombre}: --text-2 sobre las superficies`, () => {
      for (const sup of superficies) expect(ratio(v['--text-2'], sup)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Fase 0: los legados que se usan HOY en toda la app.
  it('claro: --positive / --warning / --negative / --info sobre blanco y fondo', () => {
    for (const k of ['--positive', '--warning', '--negative', '--info']) {
      for (const sup of ['#FFFFFF', light['--background']]) {
        expect(ratio(light[k], sup), `${k} sobre ${sup}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('claro: --positive / --warning / --info sobre muted', () => {
    for (const k of ['--positive', '--warning', '--info']) {
      expect(ratio(light[k], light['--muted']), k).toBeGreaterThanOrEqual(4.5);
    }
  });
  // BRECHA CONOCIDA (2026-10-12): el rojo legado #DC2626 da 4,41:1 sobre
  // --muted (#F1F5F9). No se tocó en la fase 0 (el pedido era verde y ámbar, y
  // sobre blanco pasa). Se cierra al migrar a --neg (#B42318) en la fase 3:
  // cuando eso pase, este test falla y hay que darlo vuelta a ≥ 4,5.
  it('claro: --negative sobre muted sigue por debajo de AA (pendiente fase 3)', () => {
    expect(ratio(light['--negative'], light['--muted'])).toBeLessThan(4.5);
  });
  it('oscuro: --positive / --warning / --negative / --info sobre card, fondo y muted', () => {
    for (const k of ['--positive', '--warning', '--negative', '--info']) {
      for (const sup of [dark['--card'], dark['--background'], dark['--muted']]) {
        expect(ratio(dark[k], sup), `${k} sobre ${sup}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('color de marca (spec §10)', () => {
  it('el sidebar NO flipa con el tema: sus tokens viven sólo en :root', () => {
    for (const k of ['--sidebar-bg', '--sidebar-fg', '--sidebar-muted', '--sidebar-accent', '--sidebar-active-bg']) {
      expect(light[k], k).toBeDefined();
      expect(dark[k], k).toBeUndefined();
    }
  });
  it('brand-tint y brand-wash derivan de la marca en los dos temas', () => {
    expect(light['--brand-tint']).toMatch(/^var\(--brand-tint-light, #[0-9A-F]{6}\)$/);
    expect(dark['--brand-tint']).toMatch(/^var\(--brand-tint-dark, #[0-9A-F]{6}\)$/);
    expect(light['--brand-wash']).toMatch(/^var\(--brand-wash-light, #[0-9A-F]{6}\)$/);
    expect(dark['--brand-wash']).toMatch(/^var\(--brand-wash-dark, #[0-9A-F]{6}\)$/);
  });
  // Series de gráficos sin significado: las de tono fijo, ≥ 3:1 (componente
  // gráfico) sobre la tarjeta de los dos temas. chart-1/2 son acento y tinta
  // de marca (medidos en brand-theme.test.ts); chart-3/4 son escalones claros
  // de esos dos — la leyenda repite nombre y valor, el color no es la única
  // fuente del dato.
  it('chart-5/6/7 ≥ 3:1 sobre la tarjeta clara y la oscura', () => {
    for (const k of ['--chart-5', '--chart-6', '--chart-7']) {
      expect(ratio(light[k], '#FFFFFF'), `${k} claro`).toBeGreaterThanOrEqual(3);
      expect(ratio(light[k], dark['--card']), `${k} oscuro`).toBeGreaterThanOrEqual(3);
    }
  });
  it('ningún token de significado depende de la marca', () => {
    for (const v of [light, dark]) {
      for (const k of ['--pos', '--neg', '--pend', '--info', '--stale', '--pos-bg', '--neg-bg', '--pend-bg', '--info-bg', '--stale-bg']) {
        if (v[k] !== undefined) expect(v[k], k).not.toContain('brand');
      }
    }
  });
});

describe('sin clases de doble opacidad', () => {
  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* files(p);
      else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
    }
  }

  it('ninguna `bg-x/10/30` (Tailwind la descarta en silencio)', () => {
    const hits: string[] = [];
    const re = /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|shadow)-[\w-]+\/\d+\/\d+\b/g;
    for (const f of files(join(process.cwd(), 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) hits.push(`${f.replace(process.cwd() + '/', '')}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
