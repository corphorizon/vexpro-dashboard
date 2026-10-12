// ─────────────────────────────────────────────────────────────────────────────
// Guardia del sistema visual «Libro mayor» (docs/diseno-libro-mayor.md §9).
//
// Por qué existe: el rediseño migró TODAS las pantallas a tokens el
// 2026-10-12, y el barrido final todavía encontró 443 ocurrencias en 59
// archivos (109 de paleta cruda, 38 `dark:` de color, 13 de 10/11 px y 283
// tokens legados) que se habían colado pantalla por pantalla (tabla «antes →
// después» en la doc, §9). Quedaron 2, en la allowlist. Sin una
// guardia, cada PR nuevo vuelve a meter un `text-emerald-600 dark:…` y el
// sistema se degrada en silencio — el mismo modo de falla de las listas
// duplicadas (reglas-del-proyecto.md §1.1), ahora en colores.
//
// Cómo funciona: parsea cada .ts/.tsx con el compilador de TypeScript y mira
// SÓLO los literales de string y de template (ahí viven las clases de
// Tailwind). Así los comentarios quedan afuera sin heurísticas, y el texto de
// JSX («usá red-500») también. Las reglas son las 4 categorías del barrido:
//   a) paleta cruda (`bg-red-500`, `border-slate-200`, `bg-white`, `bg-[#fff]`)
//   b) variantes `dark:` que fijan color (los tokens flipan solos en `.dark`)
//   c) `text-[10px]` / `text-[11px]` (el piso tipográfico es 11.5/12 px, §3)
//   d) tokens legados (`muted-foreground`, `bg-muted`, `text-white`,
//      `[var(--color-primary)]`, `text-primary`, `text-positive|negative|warning`,
//      `bg-positive|negative|warning`)
// Una excepción legítima va en DESIGN_GUARD_ALLOWLIST con su porqué; el test
// (design-guard.test.ts) falla con archivo:línea para todo lo demás, y también
// si una entrada de la allowlist ya no matchea nada (allowlist podrida).
//
// Descartado:
//   · Un regex sobre el archivo crudo + quitar comentarios a mano: un `//` en
//     una URL o un apóstrofe en texto de JSX («it's») rompen el lexer casero.
//     El parser de TS ya está en devDependencies y tarda ~2 s en todo `src`.
//   · Sólo una regla de ESLint: `no-restricted-syntax` ve literales sueltos
//     pero no la allowlist con motivo ni el inventario por categoría. Queda
//     como refuerzo en el editor (eslint.config.mjs), el test es la verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export type GuardCategory = 'a-paleta' | 'b-dark' | 'c-10-11px' | 'd-legado';

export interface GuardHit {
  file: string;      // relativo a la raíz del repo, con '/'
  line: number;      // 1-based
  category: GuardCategory;
  match: string;     // la clase encontrada, p. ej. 'text-emerald-600'
  text: string;      // la línea, recortada, para el mensaje
}

const FAMILIES =
  'red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|slate|gray|zinc|neutral|stone';
const PREFIXES =
  'bg|text|border(?:-[xytrblse])?|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow|accent|caret';

// `(?<![\w-])` = la clase empieza en un borde (espacio, comilla, `:` de una
// variante, `!`). `(?![\w-])` = termina ahí (se permite `/50` de opacidad).
const B = '(?<![\\w-])';
const E = '(?![\\w-])';

export const GUARD_RULES: { category: GuardCategory; re: RegExp }[] = [
  // a) paleta cruda: familia + tono, blanco/negro (salvo text-white/black, que
  //    va a «legado»), y hex arbitrario en una utilidad de color.
  { category: 'a-paleta', re: new RegExp(`${B}(?:${PREFIXES})-(?:${FAMILIES})-(?:50|[1-9]00|950)${E}`, 'g') },
  { category: 'a-paleta', re: new RegExp(`${B}(?:bg|border(?:-[xytrblse])?|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|shadow|accent|caret)-(?:white|black)${E}`, 'g') },
  { category: 'a-paleta', re: new RegExp(`${B}(?:${PREFIXES})-\\[#[0-9a-fA-F]{3,8}\\]`, 'g') },
  // b) dark: que fija color — cualquier `dark:(hover:)*<prefijo de color>-…`.
  { category: 'b-dark', re: new RegExp(`${B}dark:(?:[\\w-]+:)*(?:${PREFIXES})-[\\w\\[\\]#/.-]+`, 'g') },
  // c) cuerpo 10/11 px.
  { category: 'c-10-11px', re: /(?<![\w-])text-\[1[01]px\]/g },
  // d) tokens legados.
  { category: 'd-legado', re: new RegExp(`${B}(?:text|bg|border|ring|fill|stroke|placeholder|decoration)-muted-foreground${E}`, 'g') },
  { category: 'd-legado', re: new RegExp(`${B}bg-muted${E}`, 'g') },
  { category: 'd-legado', re: new RegExp(`${B}text-(?:white|black)${E}`, 'g') },
  { category: 'd-legado', re: /\[var\(--color-primary\)\]/g },
  { category: 'd-legado', re: new RegExp(`${B}text-primary${E}`, 'g') },
  { category: 'd-legado', re: new RegExp(`${B}(?:text|bg|border(?:-[xytrblse])?|ring|fill|stroke|from|to|via|decoration|outline|divide)-(?:positive|negative|warning)${E}`, 'g') },
];

/** Excepción legítima: el archivo, la clase exacta y el porqué. */
export interface AllowEntry {
  file: string;
  match: string;
  /** Cuántas veces puede aparecer en ese archivo (por defecto 1). */
  count?: number;
  reason: string;
}

export const DESIGN_GUARD_ALLOWLIST: AllowEntry[] = [
  {
    file: 'src/app/(dashboard)/perfil/page.tsx',
    match: 'bg-white',
    reason:
      'Placa detrás del QR de 2FA: el lector de la app autenticadora necesita módulos oscuros sobre ' +
      'blanco puro, también en tema oscuro. Un token de superficie flipa a #111723 y el QR deja de leerse.',
  },
  {
    file: 'src/components/company-logo.tsx',
    match: 'bg-white',
    reason:
      'Placa detrás del logo a color de una empresa (cualquiera, no la activa: se usa en superadmin). ' +
      'Los logos se diseñan sobre blanco; es el mismo criterio que --sidebar-plate (#FFFFFF fijo), ' +
      'pero sin acoplar este componente al token del sidebar.',
  },
];
// El velo de los modales (spec §6.1, rgb(0 0 0/.45)) NO está acá: pasó a ser
// el token `bg-scrim` (globals.css). Eran 24 `bg-black/40…60` con cuatro
// opacidades; con el token hay un solo valor y nada que exceptuar.

// ─── Recorrido ───────────────────────────────────────────────────────────────

/** Raíces que se recorren. src/lib entra entero: las reglas sólo matchean
 *  clases de Tailwind, así que un archivo sin clases no da falsos positivos. */
export const GUARD_ROOTS = ['src/app', 'src/components', 'src/lib'];

/** Archivos que no se miran: los tests (fijan clases a propósito, p. ej. que
 *  un mapa devuelva `text-pos`) y esta misma guardia (define los patrones). */
function skipped(rel: string): boolean {
  return (
    /\.test\.tsx?$/.test(rel) ||
    rel === 'src/lib/design-guard.ts'
  );
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
}

export function listGuardFiles(root: string): string[] {
  const out: string[] = [];
  for (const r of GUARD_ROOTS) walk(join(root, r), out);
  return out
    .map((p) => relative(root, p).split(sep).join('/'))
    .filter((rel) => !skipped(rel))
    .sort();
}

/** Literales de string/template de un archivo, con su posición. Los
 *  comentarios y el texto JSX no son literales: quedan afuera solos. */
function literals(sf: ts.SourceFile): { text: string; pos: number }[] {
  const out: { text: string; pos: number }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      // getText incluye las comillas/backticks: no molestan a los regex
      // (los bordes `(?<![\w-])` aceptan comilla) y la posición es exacta.
      out.push({ text: node.getText(sf), pos: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scanSource(file: string, source: string): GuardHit[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const hits: GuardHit[] = [];
  for (const lit of literals(sf)) {
    for (const { category, re } of GUARD_RULES) {
      re.lastIndex = 0;
      for (const m of lit.text.matchAll(re)) {
        const { line } = sf.getLineAndCharacterOfPosition(lit.pos + (m.index ?? 0));
        hits.push({
          file,
          line: line + 1,
          category,
          match: m[0],
          text: lines[line]?.trim().slice(0, 160) ?? '',
        });
      }
    }
  }
  return hits;
}

export function scanRepo(root: string): GuardHit[] {
  const hits: GuardHit[] = [];
  for (const rel of listGuardFiles(root)) {
    hits.push(...scanSource(rel, readFileSync(join(root, rel), 'utf8')));
  }
  return hits;
}

/** Separa lo permitido de lo que no, y devuelve las entradas podridas
 *  (que ya no matchean nada o que permiten de más). */
export function applyAllowlist(hits: GuardHit[], allow: AllowEntry[] = DESIGN_GUARD_ALLOWLIST) {
  const used = new Map<AllowEntry, number>();
  const violations: GuardHit[] = [];
  for (const h of hits) {
    const entry = allow.find(
      (a) => a.file === h.file && h.match.startsWith(a.match) && (used.get(a) ?? 0) < (a.count ?? 1),
    );
    if (entry) used.set(entry, (used.get(entry) ?? 0) + 1);
    else violations.push(h);
  }
  const stale = allow.filter((a) => (used.get(a) ?? 0) !== (a.count ?? 1));
  return { violations, stale };
}
