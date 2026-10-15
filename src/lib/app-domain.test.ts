import { describe, expect, it } from 'vitest';
import { canonicalRedirectUrl, DEFAULT_APP_URL } from './app-domain';

const base = { search: '', canonicalHost: 'dashboard.exuraglobal.com' };

describe('dominio del panel', () => {
  it('el respaldo es el dominio de Exura', () => {
    expect(DEFAULT_APP_URL).toBe('https://dashboard.exuraglobal.com');
  });
  it('sin CANONICAL_HOST no redirige nada (mudanza sin corte)', () => {
    expect(canonicalRedirectUrl({ host: 'dashboard.horizonconsulting.ai', pathname: '/socios', search: '', canonicalHost: undefined })).toBeNull();
  });
  it('las páginas del dominio viejo van al nuevo con ruta y query', () => {
    expect(canonicalRedirectUrl({ ...base, host: 'dashboard.horizonconsulting.ai', pathname: '/reset-password', search: '?token=abc' }))
      .toBe('https://dashboard.exuraglobal.com/reset-password?token=abc');
  });
  it('la API no se redirige nunca (webhook de Pay-Pros, API de partners)', () => {
    expect(canonicalRedirectUrl({ ...base, host: 'dashboard.horizonconsulting.ai', pathname: '/api/webhooks/paypros/x' })).toBeNull();
    expect(canonicalRedirectUrl({ ...base, host: 'dashboard.horizonconsulting.ai', pathname: '/api/partner/v1/accounts' })).toBeNull();
  });
  it('no toca el dominio nuevo, previews ni localhost', () => {
    expect(canonicalRedirectUrl({ ...base, host: 'dashboard.exuraglobal.com', pathname: '/' })).toBeNull();
    expect(canonicalRedirectUrl({ ...base, host: 'vexpro-dashboard-abc.vercel.app', pathname: '/' })).toBeNull();
    expect(canonicalRedirectUrl({ ...base, host: 'localhost:3100', pathname: '/' })).toBeNull();
  });
});
