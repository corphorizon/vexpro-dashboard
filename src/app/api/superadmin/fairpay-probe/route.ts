import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { getFairpayBaseUrl, getFairpayToken, isFairpayEnabled } from '@/lib/api-integrations/fairpay/auth';

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico: ¿qué endpoints expone la API de FairPay para balance y retiros?
//
// FairPay no publica documentación abierta y el portal exige login. Hoy los
// DEPÓSITOS funcionan (POST /api/v1/getTransactionList) pero el BALANCE está
// adivinado (/api/v1/getBalance → 404 confirmado) y no hay nada de RETIROS.
// Este endpoint prueba, con el token real del tenant y desde producción (la
// credencial está cifrada con la clave maestra de prod), una LISTA FIJA de
// nombres plausibles y devuelve status + primeros bytes de cada respuesta.
//
// Solo lecturas (GET / POST de listado con rango de fechas), lista cerrada
// —no acepta rutas del cliente, para no ser un proxy abierto—, solo superadmin,
// y ?company_id= obligatorio. Se borra cuando se conozcan los endpoints.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

const CANDIDATES: ReadonlyArray<readonly [method: 'GET' | 'POST', path: string, withRange: boolean]> = [
  ['GET',  '/api/v1/getBalance', false],
  ['POST', '/api/v1/getBalance', false],
  ['GET',  '/api/v1/balance', false],
  ['POST', '/api/v1/balance', false],
  ['GET',  '/api/v1/getWalletBalance', false],
  ['POST', '/api/v1/getWalletBalance', false],
  ['GET',  '/api/v1/getAccountBalance', false],
  ['POST', '/api/v1/getAccountBalance', false],
  ['GET',  '/api/v1/getMerchantBalance', false],
  ['POST', '/api/v1/getMerchantBalance', false],
  ['GET',  '/api/v1/wallet', false],
  ['GET',  '/api/v1/wallets', false],
  ['GET',  '/api/v1/account', false],
  ['GET',  '/api/v1/accounts', false],
  ['GET',  '/api/v1/merchant', false],
  ['GET',  '/api/v1/me', false],
  ['POST', '/api/v1/getAccountStatement', true],
  ['POST', '/api/v1/getStatement', true],
  ['POST', '/api/v1/accountStatement', true],
  ['POST', '/api/v1/getPayoutList', true],
  ['POST', '/api/v1/getPayouts', true],
  ['POST', '/api/v1/getWithdrawalList', true],
  ['POST', '/api/v1/getWithdrawals', true],
  ['POST', '/api/v1/getPayoutTransactionList', true],
  ['POST', '/api/v1/getSettlementList', true],
  ['POST', '/api/v1/getSettlements', true],
  ['POST', '/api/v1/getTransactionList', true], // control: se sabe que responde
];

export async function GET(request: NextRequest) {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const companyId = request.nextUrl.searchParams.get('company_id');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ success: false, error: 'company_id requerido' }, { status: 400 });
  }
  if (!(await isFairpayEnabled(companyId))) {
    return NextResponse.json({ success: false, error: 'FairPay no configurado para esta empresa' }, { status: 404 });
  }

  const baseUrl = await getFairpayBaseUrl(companyId);
  const token = await getFairpayToken(companyId);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const range = new URLSearchParams({ start_date: from, end_date: today }).toString();

  const results = [];
  for (const [method, path, withRange] of CANDIDATES) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: method === 'POST' ? (withRange ? range : '') : undefined,
        signal: AbortSignal.timeout(12_000),
      });
      const text = (await res.text()).replace(/\s+/g, ' ');
      results.push({ method, path, status: res.status, body: text.slice(0, 300) });
    } catch (err) {
      results.push({ method, path, status: 0, body: (err as Error).message.slice(0, 120) });
    }
  }

  return NextResponse.json({ success: true, baseUrl, results });
}
