// Helper de tests de las primitivas: render estático (react-dom/server) dentro
// del I18nProvider, en el entorno `node` de vitest. El repo no tiene jsdom ni
// testing-library (vitest.config.ts: «browser-side tests can be added later»),
// así que los tests verifican el HTML que sale y las funciones puras; la
// interacción se prueba llamando a los handlers del árbol de elementos.
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

/** HTML de `el` con i18n en español (el default del provider en SSR). */
export function html(el: ReactElement): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, el));
}

/** Texto visible aproximado (sin etiquetas, entidades básicas resueltas). */
export function text(el: ReactElement): string {
  return html(el)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

type AnyProps = { children?: ReactNode; [k: string]: unknown };

/** Recorre un árbol de elementos ya resuelto (sin hooks) y junta los que cumplen `pred`. */
export function findElements(node: ReactNode, pred: (el: ReactElement<AnyProps>) => boolean): ReactElement<AnyProps>[] {
  const out: ReactElement<AnyProps>[] = [];
  const visit = (n: ReactNode) => {
    if (n == null || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const el = n as ReactElement<AnyProps>;
    if (pred(el)) out.push(el);
    visit(el.props?.children);
  };
  visit(node);
  return out;
}
