import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { resolveFairpayBankingCredentials } from '@/lib/api-integrations/credentials';

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico: ¿cómo se habla con la API de banking.fairpay.online?
//
// FairPay entrega una API Key en ese portal pero ninguna documentación: ni
// URL base, ni endpoints, ni cómo se manda la key. Este sondeo prueba, desde
// producción y con la key real cifrada del tenant, una LISTA FIJA de rutas
// plausibles × tres formas de autenticación (Bearer, X-API-Key, ?api_key=)
// y devuelve status + primeros bytes de cada respuesta. Un 200 o un 401/403
// con mensaje JSON ya nos dice por dónde va.
//
// User-Agent de navegador a propósito: el banking devuelve 403 a curl y a
// cualquier UA "de bot" antes de llegar a la app (verificado 2026-08-17).
//
// Solo superadmin, solo lecturas (GET), lista cerrada. Se borra al conocer
// los endpoints reales.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PATHS = [
  '/api/v1/balance', '/api/v1/balances', '/api/v1/wallet', '/api/v1/wallets',
  '/api/v1/account', '/api/v1/accounts', '/api/v1/account/balance',
  '/api/v1/transactions', '/api/v1/statement', '/api/v1/user',
  '/api/balance', '/api/wallets', '/api/accounts', '/api/transactions',
  '/api/user', '/api/me', '/api/v2/balance', '/api/v2/wallets',
] as const;

type AuthMode = 'bearer' | 'x-api-key' | 'query';

export async function GET(request: NextRequest) {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const companyId = request.nextUrl.searchParams.get('company_id');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ success: false, error: 'company_id requerido' }, { status: 400 });
  }
  const creds = await resolveFairpayBankingCredentials(companyId);
  if (!creds) {
    return NextResponse.json({ success: false, error: 'FairPay Banking no configurado para esta empresa' }, { status: 404 });
  }

  const modes: AuthMode[] = ['bearer', 'x-api-key', 'query'];
  const results: Array<{ path: string; auth: AuthMode; status: number; body: string }> = [];

  for (const path of PATHS) {
    for (const mode of modes) {
      const url = new URL(creds.baseUrl + path);
      const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
      if (mode === 'bearer') headers.Authorization = `Bearer ${creds.apiKey}`;
      if (mode === 'x-api-key') headers['X-API-Key'] = creds.apiKey;
      if (mode === 'query') url.searchParams.set('api_key', creds.apiKey);
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        const text = (await res.text()).replace(/\s+/g, ' ');
        // Un 200 con HTML de login = no autenticado; se marca para no confundir.
        const looksHtml = /<html|<!doctype/i.test(text);
        results.push({ path, auth: mode, status: res.status, body: (looksHtml ? '[HTML] ' : '') + text.slice(0, 200) });
      } catch (err) {
        results.push({ path, auth: mode, status: 0, body: (err as Error).message.slice(0, 100) });
      }
    }
  }

  // Lo interesante primero: todo lo que NO sea 404/403 pelado ni HTML.
  const interesting = results.filter((r) => ![403, 404].includes(r.status) && !r.body.startsWith('[HTML]'));
  return NextResponse.json({ success: true, baseUrl: creds.baseUrl, interesting, all: results });
}
