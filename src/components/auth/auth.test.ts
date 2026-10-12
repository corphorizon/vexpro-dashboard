// Pantallas de acceso «Libro mayor»: render de los estados (error, carga,
// requisitos) y guardia de tokens sobre los archivos del alcance.
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme-context';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { passwordRequirements } from '@/lib/auth-form';
import { AuthShell } from './auth-shell';
import { AuthSubmit, OtpInput, PasswordInput, PasswordRequirements } from './auth-controls';
import { LoadingError, LoadingScreen } from '@/components/loading-screen';
import { Verify2FAModal } from '@/components/verify-2fa-modal';
import { NotFoundScreen } from '@/components/system-screen';

vi.mock('@/lib/api-fetch', () => ({ apiFetch: vi.fn() }));

// children como 3er argumento (react/no-children-prop); el cast es porque las
// props declaran children obligatorio.
const ce = createElement as unknown as (type: unknown, props?: unknown, ...children: unknown[]) => ReactElement;

/** HTML con i18n (es, el default en SSR) y tema. */
function html(el: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, null, el)));
}

describe('<AuthSubmit>', () => {
  it('reposo: 40 px, ancho completo, primario con text-brand-on-primary', () => {
    const out = html(ce(AuthSubmit, { loadingLabel: 'Ingresando…' }, 'Iniciar sesión'));
    expect(out).toContain('h-10');
    expect(out).toContain('w-full');
    expect(out).toContain('bg-primary');
    expect(out).toContain('text-brand-on-primary');
    expect(out).not.toContain('text-white');
    expect(out).toContain('Iniciar sesión');
    expect(out).not.toContain('aria-busy');
  });
  it('cargando: deshabilitado, aria-busy, spinner y el texto de carga', () => {
    const out = html(ce(AuthSubmit, { loading: true, loadingLabel: 'Ingresando…' }, 'Iniciar sesión'));
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('animate-spin');
    expect(out).toContain('Ingresando…');
    expect(out).not.toContain('Iniciar sesión');
  });
});

describe('estado de error de un campo de acceso', () => {
  it('Field con error + Notice: aria-invalid, borde neg, mensaje y role=alert', () => {
    const out = html(
      createElement(
        'form',
        null,
        ce(Field, { label: 'Código', error: 'Código inválido.', id: 'pin' }, createElement(OtpInput, { value: '12', onChange: () => {} })),
        createElement(Notice, { kind: 'bad', title: 'Credenciales inválidas. Quedan 2 intentos.' }),
      ),
    );
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('border-neg');
    expect(out).toContain('aria-describedby="pin-error"');
    expect(out).toContain('Código inválido.');
    expect(out).toContain('role="alert"');
    expect(out).toContain('Quedan 2 intentos');
  });
});

describe('<OtpInput>', () => {
  it('numérico, one-time-code, 6 dígitos, 24 px tabular y 48 px de alto', () => {
    const out = html(ce(Field, { label: 'Código', id: 'c' }, createElement(OtpInput, { value: '', onChange: () => {} })));
    expect(out).toContain('inputMode="numeric"');
    expect(out).toContain('autoComplete="one-time-code"');
    expect(out).toContain('maxLength="6"');
    expect(out).toContain('pattern="[0-9]{6}"');
    expect(out).toContain('text-[24px]!');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('h-12!');
    expect(out).toMatch(/<label for="c"[\s\S]*id="c"/);
  });
  it('sanea lo que llega antes de llamar onChange', () => {
    const onChange = vi.fn();
    const el = OtpInput({ value: '', onChange }) as ReactElement<{ onChange: (e: { target: { value: string } }) => void }>;
    el.props.onChange({ target: { value: '12 34-56 7' } });
    expect(onChange).toHaveBeenCalledWith('123456');
  });
});

describe('<PasswordInput>', () => {
  it('oculto por defecto, botón de 40 px con aria-pressed y nombre', () => {
    const out = html(ce(Field, { label: 'Contraseña', id: 'p' }, createElement(PasswordInput, { autoComplete: 'current-password' })));
    expect(out).toContain('type="password"');
    expect(out).toContain('autoComplete="current-password"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-label="Mostrar contraseña"');
    expect(out).toContain('w-10');
  });
  it('visible controlado y sin botón propio (campo de confirmación)', () => {
    const out = html(createElement(PasswordInput, { visible: true, hideToggle: true, 'aria-label': 'x' }));
    expect(out).toContain('type="text"');
    expect(out).not.toContain('aria-pressed');
  });
});

describe('<PasswordRequirements>', () => {
  it('cumplido en pos con check, pendiente en text-3, estado en texto para lectores', () => {
    const out = html(createElement(PasswordRequirements, { items: passwordRequirements('abcdefgh', 'x') }));
    expect(out).toContain('Al menos 8 caracteres');
    expect(out).toContain('Las dos contraseñas coinciden');
    expect(out).toMatch(/data-met="true" class="[^"]*text-pos/);
    expect(out).toMatch(/data-met="false" class="[^"]*text-text-3/);
    expect(out).toContain('(cumplido)');
    expect(out).toContain('(pendiente)');
    expect(out).toContain('aria-live="polite"');
  });
});

describe('<AuthShell>', () => {
  const out = html(createElement(AuthShell, { title: 'Iniciá sesión', subtitle: 'Usá tu email' }, 'FORM'));
  it('un h1, el formulario, y la columna de marca sólo ≥ 960 px', () => {
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('Iniciá sesión');
    expect(out).toContain('FORM');
    expect(out).toMatch(/<aside data-surface="brand-dark" class="[^"]*hidden[^"]*min-\[960px\]:flex/);
    // Mismo fondo oscuro de marca que el sidebar (spec §10).
    expect(out).toContain('bg-sidebar-bg text-sidebar-fg');
    expect(out).toContain('/brand/logo-white.png');
  });
  it('la marca es sólo texto: las tres áreas, sin cifras de ejemplo', () => {
    expect(out).toContain('Recursos Humanos');
    expect(out).toContain('Risk Management');
    expect(out).toContain('Finanzas');
    expect(out).not.toContain('cifras de ejemplo');
    expect(out).not.toMatch(/\$\d/);
  });
  it('idioma y tema con nombre accesible y 40 px', () => {
    expect(out).toContain('aria-label="Cambiar el idioma a inglés"');
    expect(out).toContain('aria-label="Cambiar a tema oscuro"');
    expect(out).toContain('size-10');
  });
});

describe('<LoadingScreen> / <LoadingError>', () => {
  it('arranque: logo, barra accent sobre surface-sunk, «Cargando» para lectores, sin pista lenta todavía', () => {
    const out = html(createElement(LoadingScreen, { onRetry: () => {} }));
    expect(out).toContain('/brand/logo-black.png');
    expect(out).toContain('bg-surface-sunk');
    expect(out).toContain('bg-accent');
    expect(out).toContain('role="status"');
    expect(out).toContain('Cargando');
    expect(out).not.toContain('Está tardando');
  });
  it('lento: texto 13 px text-2 y botón secundario «Reintentar ahora»', () => {
    const out = html(createElement(LoadingScreen, { onRetry: () => {}, initialSlow: true }));
    expect(out).toContain('Está tardando más de lo normal');
    expect(out).toMatch(/text-\[13px\] leading-5 text-text-2">Está tardando/);
    expect(out).toContain('Reintentar ahora');
    expect(out).toContain('border-border-strong');
  });
  it('lento sin onRetry: avisa pero no ofrece un botón que no hace nada', () => {
    const out = html(createElement(LoadingScreen, { initialSlow: true }));
    expect(out).toContain('Está tardando');
    expect(out).not.toContain('Reintentar ahora');
  });
  it('error de carga: role=alert, título neg con ícono, el mensaje y Reintentar', () => {
    const out = html(createElement(LoadingError, { message: 'Timeout de 15 s', onRetry: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('No pudimos cargar los datos');
    expect(out).toMatch(/text-neg"><svg/);
    expect(out).toContain('Timeout de 15 s');
    expect(out).toContain('Reintentar');
  });
});

describe('<Verify2FAModal>', () => {
  it('cerrado no dibuja nada', () => {
    // (el <script> es el anti-parpadeo de ThemeProvider, no del modal)
    const out = html(createElement(Verify2FAModal, { open: false, onVerified: () => {}, onClose: () => {} }));
    expect(out.replace(/<script>[\s\S]*<\/script>/, '')).toBe('');
  });
  it('abierto: diálogo modal con título, input con label, X con nombre, botón deshabilitado sin 6 dígitos', () => {
    const out = html(createElement(Verify2FAModal, { open: true, onVerified: () => {}, onClose: () => {} }));
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"/);
    expect(out).toContain('Verificación 2FA');
    expect(out).toMatch(/<label for="[^"]+"[^>]*>Código de verificación/);
    expect(out).toContain('aria-label="Cerrar"');
    expect(out).toMatch(/<button type="submit" disabled=""/);
  });
});

describe('<NotFoundScreen>', () => {
  it('404 en text-3, título, bajada y enlace primario al inicio', () => {
    const out = html(createElement(NotFoundScreen));
    expect(out).toContain('404');
    expect(out).toContain('Página no encontrada');
    expect(out).toContain('href="/"');
    expect(out).toContain('Volver al inicio');
    expect(out).toContain('text-brand-on-primary');
  });
});

// Guardia: las pantallas de este alcance usan sólo tokens (spec §2.1 y §9).
describe('sólo tokens en las pantallas de acceso, arranque y 404', () => {
  const root = path.resolve(__dirname, '../../..');
  const files = [
    'src/app/login/page.tsx',
    'src/app/reset-password/page.tsx',
    'src/app/reset-2fa/page.tsx',
    'src/app/setup-2fa/page.tsx',
    'src/app/not-found.tsx',
    'src/app/global-error.tsx',
    'src/components/auth/auth-shell.tsx',
    'src/components/auth/auth-controls.tsx',
    'src/components/auth-brand.tsx',
    'src/components/loading-screen.tsx',
    'src/components/system-screen.tsx',
    'src/components/verify-2fa-modal.tsx',
  ];
  const PALETTE = /\b(text|bg|border|ring|fill|stroke|from|to|via)-(red|rose|emerald|green|amber|yellow|orange|blue|sky|indigo|violet|purple|slate|gray|zinc|neutral|white)(-\d{2,3})?\b/;
  const DARK_COLOR = /dark:(text|bg|border|ring)-/;
  const HEX = /#[0-9a-fA-F]{3,8}\b/;
  const RAW_VAR = /\[var\(--color-(primary|secondary)\)\]|text-\[10px\]/;
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(path.join(root, f), 'utf8')
        // Las cabeceras citan lo que había antes (p. ej. «`#F1F5F9`»): se ignoran los comentarios.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(PALETTE);
      expect(src).not.toMatch(DARK_COLOR);
      expect(src).not.toMatch(HEX);
      expect(src).not.toMatch(RAW_VAR);
    });
  }
});
