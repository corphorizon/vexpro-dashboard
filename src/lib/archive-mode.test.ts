import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createElement } from 'react';

// auth-context crea el cliente de Supabase al importarse: valores de relleno.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'relleno-de-test';
});

// El middleware real refresca la sesión con Supabase: acá sólo importa si
// el modo archivo corta ANTES. Si la petición pasa, se ve este marcador.
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: vi.fn(async () => NextResponse.next({ headers: { 'x-paso-al-handler': '1' } })),
}));

import {
  ARCHIVE_CUTOFF_DATE,
  ARCHIVE_ERROR_CODE,
  ARCHIVE_MESSAGE,
  ARCHIVE_MODE,
  ARCHIVE_PARTNER_API_OPEN,
  ARCHIVE_WRITE_ALLOWLIST,
  archiveDecision,
  archiveNoticeVisible,
} from './archive-mode';
import { middleware } from '@/middleware';
import { apiFetch } from './api-fetch';
import { MIGRATED_TO_ATLAS } from './atlas-migration';
import { canAdd, canDelete, canEdit, isCompanyAdmin, type User } from './auth-context';
import {
  roleCanApproveWithdrawal,
  roleCanPreparePaymentOrder,
  roleCanTriageWithdrawal,
  roleCanWriteFinance,
  roleCanWriteHr,
} from './roles';
import { canAccessModule } from './modules';
import { html } from '@/test/render';
import { AtlasMigrationBannerView } from '@/components/atlas-migration-notice';
import vercel from '../../vercel.json';

const EXURA_PRIME_FICTICIA = '11111111-2222-3333-4444-555555555555';

function req(method: string, path: string) {
  return new NextRequest(new URL(path, 'https://dashboard.example.test'), { method });
}

async function body(res: Response) {
  return (await res.json()) as { success: boolean; error: string; code: string; reason: string };
}

describe('interruptor', () => {
  it('el modo archivo está ENCENDIDO en código y la fecha de corte es 2026-10-20', () => {
    expect(ARCHIVE_MODE).toBe(true);
    expect(ARCHIVE_CUTOFF_DATE).toBe('2026-10-20');
  });

  it('el mensaje es el pedido, con la fecha y el host de Atlas', () => {
    expect(ARCHIVE_MESSAGE).toBe(
      'Smart Dashboard está archivado: solo consulta, con los datos hasta el 2026-10-20. Todo el trabajo sigue en Atlas: atlas.exuraglobal.com',
    );
  });

  it('vercel.json no programa ningún cron', () => {
    expect(vercel.crons).toEqual([]);
  });
});

describe('archiveDecision', () => {
  const WRITE_ROUTES: Array<[string, string]> = [
    ['POST', '/api/admin/data'],
    ['POST', '/api/admin/expenses'],
    ['PATCH', '/api/admin/ib-rebates/abc'],
    ['DELETE', '/api/admin/payment-orders/abc'],
    ['PUT', '/api/reports/config'],
    ['POST', '/api/admin/hedge-fund/sync'],
    ['POST', '/api/superadmin/liquidity/refresh-all'],
    ['POST', '/api/admin/commission-net-input/refresh'],
    ['POST', '/api/assistant/chat'],
    ['PATCH', '/api/user/language'],
    ['POST', '/api/admin/reset-password'], // reset hecho por un admin: NO es excepción
    ['POST', '/api/superadmin/partner-tokens'],
    ['POST', '/api/partner/v1/customers'], // la API de socio abierta es sólo lectura
  ];

  it.each(WRITE_ROUTES)('%s %s → bloqueada (write)', (m, p) => {
    expect(archiveDecision(m, p, true)).toEqual({ blocked: true, reason: 'write' });
  });

  const CRONS = [...new Set([
    '/api/cron/sync-external-apis', '/api/cron/daily-balance-snapshot', '/api/cron/create-new-period',
    '/api/cron/daily-financial-report', '/api/cron/weekly-financial-report', '/api/cron/monthly-financial-report',
    '/api/cron/notification-sweep', '/api/cron/sync-crm', '/api/cron/sync-health', '/api/cron/mt5-pnl',
    '/api/cron/propfirm-review', '/api/cron/account-review',
  ])];

  it.each(CRONS)('GET %s → bloqueado (ingest), con cualquier método', (p) => {
    for (const m of ['GET', 'POST', 'HEAD']) {
      expect(archiveDecision(m, p, true)).toEqual({ blocked: true, reason: 'ingest' });
    }
    expect(archiveDecision('GET', `${p}/`, true)).toEqual({ blocked: true, reason: 'ingest' });
  });

  it.each([
    '/api/integrations/movements', '/api/integrations/coinsbuy/wallets', '/api/integrations/unipayment/balances',
    '/api/integrations/fairpay/transactions', '/api/integrations/orion-crm/ping', '/api/admin/onchain-live',
    '/api/superadmin/mt5-sql-probe', '/api/superadmin/orion-mongo-probe',
  ])('GET en vivo %s → bloqueado (ingest)', (p) => {
    expect(archiveDecision('GET', p, true)).toEqual({ blocked: true, reason: 'ingest' });
  });

  it.each(ARCHIVE_WRITE_ALLOWLIST)('%s sigue abierta (acceso)', (p) => {
    expect(archiveDecision('POST', p, true)).toEqual({ blocked: false });
    expect(archiveDecision('DELETE', p, true)).toEqual({ blocked: false });
  });

  it('las lecturas siguen abiertas', () => {
    for (const p of [
      '/api/bootstrap', '/api/admin/audit-log', '/api/integrations/persisted-movements',
      '/api/integrations/period-totals', '/api/balances/total-consolidado', '/api/health',
    ]) {
      expect(archiveDecision('GET', p, true)).toEqual({ blocked: false });
    }
  });

  it('el prefijo no se confunde con una ruta vecina', () => {
    // '/api/auth/login-gate' abierto NO abre '/api/auth/login-gatex'.
    expect(archiveDecision('POST', '/api/auth/login-gatex', true).blocked).toBe(true);
    // '/api/integrations/movements' cortado NO corta persisted-movements.
    expect(archiveDecision('GET', '/api/integrations/persisted-movements', true).blocked).toBe(false);
  });

  it('el webhook de Pay-Pros pasa: la ruta responde 200 sin escribir', () => {
    expect(archiveDecision('POST', '/api/webhooks/paypros/tok', true)).toEqual({ blocked: false });
  });

  it('API de socio: abierta mientras ARCHIVE_PARTNER_API_OPEN, 410 al cerrarla', () => {
    expect(ARCHIVE_PARTNER_API_OPEN).toBe(true);
    for (const p of ['/api/partner/v1/customers', '/api/partner/v1/trading-activity']) {
      expect(archiveDecision('GET', p, true, true)).toEqual({ blocked: false });
      expect(archiveDecision('GET', p, true, false)).toEqual({ blocked: true, reason: 'partner' });
    }
  });

  it('las páginas (no /api) nunca se cortan', () => {
    expect(archiveDecision('POST', '/login', true)).toEqual({ blocked: false });
    expect(archiveDecision('GET', '/upload', true)).toEqual({ blocked: false });
  });

  it('sin modo archivo no se corta nada', () => {
    expect(archiveDecision('POST', '/api/admin/data', false)).toEqual({ blocked: false });
    expect(archiveDecision('GET', '/api/cron/sync-crm', false)).toEqual({ blocked: false });
  });
});

describe('middleware en modo archivo', () => {
  it('una ruta de escritura devuelve 410 con el aviso, sin llegar al handler', async () => {
    const res = await middleware(req('POST', '/api/admin/data'));
    expect(res.status).toBe(410);
    expect(res.headers.get('x-paso-al-handler')).toBeNull();
    const b = await body(res);
    expect(b).toMatchObject({ success: false, code: ARCHIVE_ERROR_CODE, reason: 'write' });
    expect(b.error).toBe(ARCHIVE_MESSAGE);
  });

  it('los crons devuelven 410', async () => {
    for (const path of new Set(vercel.crons.map((c: { path: string }) => c.path).concat([
      '/api/cron/sync-crm?mode=full', '/api/cron/mt5-pnl', '/api/cron/sync-external-apis',
    ]))) {
      const res = await middleware(req('GET', path));
      expect(res.status, path).toBe(410);
      expect((await body(res)).reason).toBe('ingest');
    }
  });

  it('el login sigue funcionando: login-gate y verify-2fa llegan al handler', async () => {
    for (const path of ['/api/auth/login-gate', '/api/auth/verify-2fa', '/api/auth/forgot-password']) {
      const res = await middleware(req('POST', path));
      expect(res.status, path).not.toBe(410);
      expect(res.headers.get('x-paso-al-handler'), path).toBe('1');
    }
    // Y la pantalla de login misma.
    const page = await middleware(req('GET', '/login'));
    expect(page.headers.get('x-paso-al-handler')).toBe('1');
  });

  it('una lectura sigue llegando al handler', async () => {
    const res = await middleware(req('GET', '/api/bootstrap'));
    expect(res.headers.get('x-paso-al-handler')).toBe('1');
  });
});

describe('apiFetch en modo archivo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('una escritura no sale del navegador y devuelve la misma 410', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await apiFetch('/api/admin/data', { method: 'POST', body: '{}' });
    expect(res.status).toBe(410);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await body(res)).error).toBe(ARCHIVE_MESSAGE);
  });

  it('el login sí sale', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('window', undefined);
    const res = await apiFetch('/api/auth/forgot-password', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('UI: nadie escribe', () => {
  const admin = {
    id: 'u1', email: 'a@x.test', name: 'A', role: 'admin', effective_role: 'admin',
    is_superadmin: false, allowed_modules: [],
  } as unknown as User;
  const superadmin = { ...admin, role: 'superadmin', effective_role: 'superadmin', is_superadmin: true } as unknown as User;

  it('canAdd/canEdit/canDelete/isCompanyAdmin son false incluso para admin y superadmin', () => {
    for (const u of [admin, superadmin]) {
      expect(canAdd(u)).toBe(false);
      expect(canEdit(u)).toBe(false);
      expect(canDelete(u)).toBe(false);
      expect(isCompanyAdmin(u)).toBe(false);
    }
  });

  it('los helpers de escritura por dominio son false para todo rol', () => {
    for (const r of ['admin', 'auditor', 'hr', 'superadmin', 'soporte']) {
      expect(roleCanWriteFinance(r)).toBe(false);
      expect(roleCanWriteHr(r)).toBe(false);
      expect(roleCanPreparePaymentOrder(r)).toBe(false);
      expect(roleCanTriageWithdrawal(r)).toBe(false);
      expect(roleCanApproveWithdrawal(r)).toBe(false);
    }
  });

  it('la carga de datos y el asistente desaparecen; el resto se sigue viendo', () => {
    const ctx = { role: 'admin', isSuperadmin: true };
    expect(canAccessModule('upload', ctx)).toBe(false);
    expect(canAccessModule('assistant', ctx)).toBe(false);
    expect(canAccessModule('expenses', ctx)).toBe(true);
  });
});

describe('aviso para cualquier empresa', () => {
  it('se muestra para las migradas, para las Exura, para cualquier otra y sin empresa', () => {
    for (const id of Object.keys(MIGRATED_TO_ATLAS)) expect(archiveNoticeVisible(id)).toBe(true);
    expect(archiveNoticeVisible(EXURA_PRIME_FICTICIA)).toBe(true);
    expect(archiveNoticeVisible('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(archiveNoticeVisible(null)).toBe(true);
    expect(archiveNoticeVisible(undefined)).toBe(true);
  });

  it('sin modo archivo vuelve al criterio de antes (sólo las migradas)', () => {
    expect(archiveNoticeVisible(EXURA_PRIME_FICTICIA, false)).toBe(false);
    expect(archiveNoticeVisible(Object.keys(MIGRATED_TO_ATLAS)[0], false)).toBe(true);
  });

  it('el banner dice el texto pedido con la fecha de corte', () => {
    const out = html(createElement(AtlasMigrationBannerView));
    const plain = out.replace(/<[^>]+>/g, '');
    expect(plain).toContain(
      'Smart Dashboard está archivado: solo consulta, con los datos hasta el 2026-10-20. Todo el trabajo sigue en Atlas: atlas.exuraglobal.com',
    );
  });
});
