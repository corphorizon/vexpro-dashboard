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

// Ronda 2 (2026-08-17): con la API Key cruda, /api/v1/accounts respondió
// "Wrong number of segments" → la API espera un JWT en Authorization, igual
// que portal.fairpay.online. Se canjea la key por JWT en getAccessToken y
// se prueban las rutas con ese token. Se intentan dos rutas de canje.
const TOKEN_ENDPOINTS = ['/api/auth/getAccessToken', '/api/v1/auth/getAccessToken', '/api/auth/login', '/api/v1/getAccessToken'] as const;

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

  const jsonHeaders = { 'User-Agent': UA, Accept: 'application/json' };

  // 1) Canje de la API key por JWT — probar varias rutas y dos formatos de body.
  const tokenAttempts: Array<{ endpoint: string; body: string; status: number; snippet: string; token: string | null }> = [];
  let jwt: string | null = null;
  for (const ep of TOKEN_ENDPOINTS) {
    for (const bodyKind of ['form', 'json'] as const) {
      if (jwt) break;
      try {
        const res = await fetch(creds.baseUrl + ep, {
          method: 'POST',
          headers: {
            ...jsonHeaders,
            'Content-Type': bodyKind === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
          },
          body: bodyKind === 'form'
            ? new URLSearchParams({ api_key: creds.apiKey }).toString()
            : JSON.stringify({ api_key: creds.apiKey }),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let token: string | null = null;
        try {
          const j = JSON.parse(text) as { data?: { scalar?: string; token?: string; access_token?: string }; token?: string; access_token?: string };
          token = j.data?.scalar ?? j.data?.token ?? j.data?.access_token ?? j.token ?? j.access_token ?? null;
        } catch { /* no JSON */ }
        // Sólo aceptamos algo con pinta de JWT (3 segmentos).
        if (token && token.split('.').length !== 3) token = null;
        tokenAttempts.push({ endpoint: `${ep} (${bodyKind})`, body: bodyKind, status: res.status, snippet: text.replace(/\s+/g, ' ').slice(0, 160), token: token ? token.slice(0, 12) + '…' : null });
        if (token) jwt = token;
      } catch (err) {
        tokenAttempts.push({ endpoint: `${ep} (${bodyKind})`, body: bodyKind, status: 0, snippet: (err as Error).message.slice(0, 100), token: null });
      }
    }
  }

  // 2) Ronda 3: /api/v1/accounts YA responde la lista de cuentas (con currency
  //    y balance). Se trae ENTERA y, por cada cuenta, se prueban las rutas por
  //    id que suelen dar el estado de cuenta (depósitos/retiros).
  if (!jwt) {
    return NextResponse.json({ success: false, error: 'No se pudo canjear la API key por JWT', tokenAttempts });
  }
  const H = { ...jsonHeaders, Authorization: `Bearer ${jwt}` };
  const accountsRes = await fetch(creds.baseUrl + '/api/v1/accounts', { headers: H, signal: AbortSignal.timeout(10_000) });
  const accountsText = await accountsRes.text();
  let accounts: Array<Record<string, unknown>> = [];
  try { const j = JSON.parse(accountsText); accounts = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []); } catch { /* no JSON */ }

  // Resumen legible de cuentas: id, número, tipo, moneda, balance.
  const accountSummary = accounts.map((a) => ({
    id: a.id, account_number: a.account_number, account_type: a.account_type,
    currency: a.currency, balance: a.balance, status: a.status,
  }));

  // Rutas por cuenta a probar (sólo GET). Se limita a las primeras 6 cuentas
  // para no disparar decenas de llamadas si el usuario tiene muchas.
  const perAccountPaths = (id: unknown) => [
    `/api/v1/accounts/${id}`,
    `/api/v1/accounts/${id}/transactions`,
    `/api/v1/accounts/${id}/statement`,
    `/api/v1/accounts/${id}/balance`,
    `/api/v1/accounts/${id}/movements`,
    `/api/v1/accounts/${id}/history`,
    `/api/v1/transactions?account_id=${id}`,
    `/api/v1/accounts/transactions?account_id=${id}`,
    `/api/v1/accounts/statement?account_id=${id}`,
  ];
  const results: Array<{ path: string; status: number; body: string }> = [];
  for (const acc of accounts.slice(0, 6)) {
    for (const path of perAccountPaths(acc.id)) {
      try {
        const res = await fetch(creds.baseUrl + path, { headers: H, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        const text = (await res.text()).replace(/\s+/g, ' ');
        results.push({ path, status: res.status, body: text.slice(0, 500) });
      } catch (err) {
        results.push({ path, status: 0, body: (err as Error).message.slice(0, 100) });
      }
    }
  }
  const interesting = results.filter((r) => r.status === 200 && r.body !== '{}' && r.body !== '[]');
  return NextResponse.json({ success: true, baseUrl: creds.baseUrl, jwtObtained: true, accountsRaw: accountsText.slice(0, 3000), accountSummary, interesting, all: results });

}
