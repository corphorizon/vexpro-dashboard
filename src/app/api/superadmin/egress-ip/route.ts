import { NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { proxiedFetch, isProxyEnabled } from '@/lib/api-integrations/proxy';

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico: ¿con qué IP sale el dashboard hacia los proveedores?
//
// Coinsbuy, UniPayment y Pay-Pros exigen whitelistear la IP de origen. Vercel
// no tiene IP fija, así que ese tráfico sale por el proxy SOCKS5 de Fixie
// (FIXIE_URL). Este endpoint hace una llamada de prueba POR EL MISMO CAMINO
// que usan las integraciones y devuelve la IP que ve el destino — es la que
// hay que darle al proveedor. Se consulta a dos servicios distintos y se
// comparan para no confiar en uno solo.
//
// Solo superadmin: la IP de salida no es secreta, pero tampoco hace falta
// exponer un endpoint que haga fetches salientes a cualquiera con sesión.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

const PROBES = ['https://api.ipify.org?format=json', 'https://ifconfig.me/all.json'] as const;

async function probe(url: string): Promise<string | null> {
  try {
    const res = await proxiedFetch(url, {
      headers: { 'User-Agent': 'SmartDashboard/1.0 egress-probe', Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ip?: string; ip_addr?: string };
    return json.ip ?? json.ip_addr ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const [a, b] = await Promise.all(PROBES.map(probe));
  const ips = [a, b].filter((v): v is string => !!v);
  const unique = [...new Set(ips)];

  return NextResponse.json({
    success: true,
    proxyEnabled: isProxyEnabled(),
    // Si el proxy no está activo (local), esta es la IP dinámica de la
    // máquina/lambda: NO sirve para whitelistear. Solo vale en producción.
    egressIps: unique,
    consistent: unique.length === 1,
    probes: { ipify: a, ifconfig: b },
  });
}
