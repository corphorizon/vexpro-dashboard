// ─────────────────────────────────────────────────────────────────────────────
// Guardia del sistema visual «Libro mayor» — ver la cabecera de
// design-guard.ts y docs/diseno-libro-mayor.md §9.
//
// Si este test falla en tu PR: la salida dice archivo:línea, la categoría y
// la clase. Cambiala por el token (tabla en la doc, §9.1). Si de verdad es
// una excepción, agregala a DESIGN_GUARD_ALLOWLIST con el porqué — y esperá
// que alguien lo discuta en la revisión.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  DESIGN_GUARD_ALLOWLIST,
  applyAllowlist,
  listGuardFiles,
  scanRepo,
  scanSource,
  type GuardHit,
} from './design-guard';

const root = process.cwd();

const fmt = (h: GuardHit) => `  ${h.file}:${h.line}  [${h.category}]  ${h.match}\n      ${h.text}`;

describe('design-guard — el repo', () => {
  const hits = scanRepo(root);
  const { violations, stale } = applyAllowlist(hits);

  it('ninguna paleta cruda, dark: de color, 10/11 px ni token legado fuera de la allowlist', () => {
    expect(violations.length, `\n${violations.length} clase(s) fuera del sistema:\n${violations.map(fmt).join('\n')}\n`).toBe(0);
  });

  it('la allowlist no tiene entradas podridas (cada una matchea exactamente lo que declara)', () => {
    expect(stale, 'entradas que ya no matchean (o matchean otra cantidad): borralas o corregí `count`').toEqual([]);
  });

  it('cada entrada de la allowlist explica el porqué', () => {
    for (const a of DESIGN_GUARD_ALLOWLIST) expect(a.reason.length, `${a.file} ${a.match}`).toBeGreaterThan(40);
  });

  it('recorre las tres raíces y salta los tests', () => {
    const files = listGuardFiles(root);
    expect(files.some((f) => f.startsWith('src/app/'))).toBe(true);
    expect(files.some((f) => f.startsWith('src/components/'))).toBe(true);
    expect(files).toContain('src/lib/hr/domain.ts');
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
    // Si alguien rompe el recorrido, «0 violaciones» pasaría en silencio.
    expect(files.length).toBeGreaterThan(300);
  });
});

describe('design-guard — el escáner (casos chicos)', () => {
  const scan = (src: string) => scanSource('x.tsx', src).map((h) => `${h.category} ${h.match}`);

  it('detecta las cuatro categorías', () => {
    const out = scan(`const a = <p className="bg-red-500 dark:bg-slate-900 text-[10px] text-muted-foreground" />;`);
    expect(out).toContain('a-paleta bg-red-500');
    expect(out).toContain('a-paleta bg-slate-900'); // también dentro de dark:
    expect(out).toContain('b-dark dark:bg-slate-900');
    expect(out).toContain('c-10-11px text-[10px]');
    expect(out).toContain('d-legado text-muted-foreground');
  });

  it('respeta variantes y opacidad: hover:, group-hover:, /50', () => {
    expect(scan(`x('hover:bg-emerald-600/50 group-hover:text-white')`)).toEqual([
      'a-paleta bg-emerald-600',
      'd-legado text-white',
    ]);
  });

  it('legados: bg-muted, [var(--color-primary)], text-primary, positive/negative/warning', () => {
    const out = scan(`x('bg-muted/40 bg-[var(--color-primary)] text-primary border-l-negative bg-warning/10')`);
    expect(out).toEqual([
      'd-legado bg-muted',
      'd-legado [var(--color-primary)]',
      'd-legado text-primary',
      'd-legado border-l-negative',
      'd-legado bg-warning',
    ]);
  });

  it('NO marca los tokens nuevos ni los nombres parecidos', () => {
    expect(
      scan(`x('text-text-3 bg-surface-2 text-pos bg-pos-bg border-neg/30 text-brand-ink bg-primary text-brand-on-primary bg-scrim text-[11.5px] text-xs bg-brand-tint')`),
    ).toEqual([]);
    // `bg-muted-foreground` es legado; `bg-muted` dentro de otra palabra no.
    expect(scan(`x('my-bg-muted-thing')`)).toEqual([]);
  });

  it('ignora comentarios y texto de JSX: sólo mira literales', () => {
    const src = [
      '// antes era text-emerald-600 dark:text-emerald-400',
      '/* bg-red-50 text-[11px] */',
      'const a = <p>usá text-white sobre bg-slate-900</p>;',
      "const b = 'text-pos';",
    ].join('\n');
    expect(scan(src)).toEqual([]);
  });

  it('mira también templates con interpolación', () => {
    const out = scan('const c = `px-2 ${on ? "text-white" : "text-text-2"} bg-gray-100`;');
    expect(out).toEqual(['d-legado text-white', 'a-paleta bg-gray-100']);
  });

  it('informa la línea correcta', () => {
    const [h] = scanSource('y.ts', "const a = 1;\n\nconst b = 'bg-amber-100';\n");
    expect(h.line).toBe(3);
  });

  it('allowlist: permite sólo lo declarado y detecta entradas podridas', () => {
    const hits = scanSource('z.tsx', `x('bg-white'); y('bg-white');`);
    const allow = [{ file: 'z.tsx', match: 'bg-white', reason: 'r' }];
    const r1 = applyAllowlist(hits, allow);
    expect(r1.violations).toHaveLength(1); // count por defecto = 1
    expect(r1.stale).toEqual([]);
    const r2 = applyAllowlist([], allow);
    expect(r2.stale).toEqual(allow); // ya no matchea: hay que borrarla
  });
});
