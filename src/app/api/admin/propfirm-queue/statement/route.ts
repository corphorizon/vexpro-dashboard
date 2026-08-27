// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/propfirm-queue/statement?login=…&withdrawId=…&source=own|orion
//
// El informe de la cuenta que el revisor abre en otra pestaña: TODAS las
// operaciones del ciclo, con la forma de un statement de MetaTrader y la marca
// de la empresa.
//
// ── POR QUÉ LO GENERAMOS NOSOTROS Y NO LO PEDIMOS AL CRM ────────────────────
// Orion guarda informes propios en `propfirm_audit_reports` (login, bytes,
// createdAt, html, motivo). Sondeado contra producción el 2026-08-27:
//
//     18 informes en total, 18 logins distintos
//     motivos: DAILY_LOSS / OVERALL_LOSS — se generan cuando una cuenta se
//     DESCALIFICA por pérdida, no cuando alguien pide un retiro
//     de los 3 retiros pendientes de hoy, 0 tienen informe
//
// O sea: el documento del CRM existe, pero cubre el caso contrario al nuestro.
// Esperar a que aparezca dejaría al revisor sin informe justo en los retiros
// que tiene que revisar. Por eso el principal es el que armamos desde MT5, y
// el de Orion se ofrece ADEMÁS cuando existe (`source=orion`), porque cuando
// existe es el documento oficial del CRM.
//
// ── EL CICLO, NO LA VIDA DE LA CUENTA ──────────────────────────────────────
// Se usa `loadCycleFromMt5`, el mismo cargador de la revisión: las operaciones
// son las del ciclo VIGENTE. Un informe con las operaciones de ciclos ya
// pagados enseñaría infracciones saldadas y contradiría a la revisión de al
// lado, que es peor que no tener informe.
//
// Auth: la misma que la cola (`WITHDRAWAL_REVIEW_READ_ROLES` + módulo `risk`),
// y ADEMÁS el login tiene que estar en la cola de ESTA empresa: sin eso la
// ruta sería un volcador de historiales de cualquier cuenta del broker con
// sólo cambiar un número en la URL.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { loadCycleFromMt5 } from '@/lib/risk/propfirm-auto';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { BRAND_HEX } from '@/lib/brand';
import type { Trade } from '@/lib/risk/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Cabeceras del documento.
 *
 * `sandbox` deja la página en un origen opaco y sin scripts: el HTML de Orion
 * lo escribió otro sistema y se sirve desde NUESTRO dominio, así que sin esto
 * un informe con un `<script>` correría con la sesión del revisor.
 */
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox",
  // Un informe no se cachea: la cuenta sigue operando.
  'Cache-Control': 'no-store',
} as const;

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cuando = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

const duracion = (min: number) => {
  if (min < 60) return `${min.toFixed(1)}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${Math.round(min % 60)}m`;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: WITHDRAWAL_REVIEW_READ_ROLES,
      modules: ['risk'],
    });
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const login = Number(url.searchParams.get('login'));
    const withdrawId = url.searchParams.get('withdrawId');
    const source = url.searchParams.get('source') === 'orion' ? 'orion' : 'own';
    if (!Number.isFinite(login) || login <= 0) {
      return NextResponse.json({ success: false, error: 'login inválido' }, { status: 400 });
    }

    const admin = createAdminClient();

    // ── El login TIENE que estar en la cola de esta empresa ────────────────
    // Ver la cabecera: es lo único que impide leer el historial de cualquier
    // cuenta del broker cambiando el número de la URL.
    let q = admin
      .from('propfirm_withdrawal_queue')
      .select('withdraw_id, login, username, user_email, program_name, requested_amount, requested_date, status, review_cycle')
      .eq('company_id', auth.companyId)
      .eq('login', login);
    if (withdrawId) q = q.eq('withdraw_id', withdrawId);
    const { data: filas, error: errFila } = await q
      .order('requested_date', { ascending: false, nullsFirst: false })
      .limit(1);
    if (errFila) throw new Error(errFila.message);
    const fila = (filas ?? [])[0] as Record<string, unknown> | undefined;
    if (!fila) {
      return NextResponse.json(
        { success: false, error: 'Esa cuenta no tiene retiros de prop firm en esta empresa' },
        { status: 404 },
      );
    }

    const { data: empresa } = await admin
      .from('companies')
      .select('name, logo_url')
      .eq('id', auth.companyId)
      .single();
    const marca = {
      name: (empresa?.name as string | undefined) ?? 'Smart Dashboard',
      logo: (empresa?.logo_url as string | null | undefined) ?? null,
    };

    // ── El documento oficial del CRM, cuando existe ────────────────────────
    if (source === 'orion') {
      const html = await withOrionMongo(auth.companyId, async ({ db }) => {
        const doc = await db
          .collection('propfirm_audit_reports')
          // `login` viaja como TEXTO en Orion.
          .find({ login: String(login) })
          .sort({ createdAt: -1 })
          .limit(1)
          .toArray();
        return doc[0]?.html ? String(doc[0].html) : null;
      });
      if (!html) {
        return new NextResponse(
          paginaSimple(marca, `No hay informe del CRM para la cuenta ${login}`,
            'Orion sólo genera este informe cuando la cuenta se descalifica por pérdida. Use el informe generado desde MetaTrader.'),
          { headers: { ...HTML_HEADERS } },
        );
      }
      return new NextResponse(html, { headers: { ...HTML_HEADERS } });
    }

    const cycle = await loadCycleFromMt5(auth.companyId, login);
    return new NextResponse(statementHtml(marca, fila, cycle.trades, cycle), { headers: { ...HTML_HEADERS } });
  } catch (err) {
    return apiError('admin/propfirm-queue/statement', err, { status: 500 });
  }
}

// ─── El documento ────────────────────────────────────────────────────────────

const ESTILO = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${BRAND_HEX.surface}; color: ${BRAND_HEX.ink};
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .hoja { max-width: 1120px; margin: 0 auto; background: #fff; }
  header { background: ${BRAND_HEX.primary}; color: #fff; padding: 20px 24px;
           display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  header h1 { font-size: 19px; margin: 0 0 4px; }
  header p { margin: 0; font-size: 12px; opacity: .85; }
  header img { max-height: 40px; max-width: 160px; }
  .acento { height: 3px; background: ${BRAND_HEX.accent}; }
  .cuerpo { padding: 20px 24px 32px; }
  .datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .dato { border: 1px solid ${BRAND_HEX.border}; border-radius: 6px; padding: 8px 10px; }
  .dato span { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: ${BRAND_HEX.muted}; }
  .dato strong { font-size: 14px; font-variant-numeric: tabular-nums; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: ${BRAND_HEX.inkSoft};
       border-bottom: 1px solid ${BRAND_HEX.border}; padding-bottom: 6px; margin: 22px 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; font-variant-numeric: tabular-nums; }
  th { background: ${BRAND_HEX.primary}; color: #fff; text-align: left; padding: 6px 7px; font-weight: 600; white-space: nowrap; }
  td { padding: 5px 7px; border-bottom: 1px solid ${BRAND_HEX.border}; white-space: nowrap; }
  tbody tr:nth-child(even) { background: ${BRAND_HEX.surface}; }
  tfoot td { font-weight: 700; border-top: 2px solid ${BRAND_HEX.primary}; background: #fff; }
  .num { text-align: right; }
  .pos { color: ${BRAND_HEX.positive}; }
  .neg { color: ${BRAND_HEX.negative}; }
  .nota { margin-top: 18px; font-size: 11px; color: ${BRAND_HEX.muted}; line-height: 1.5; }
  .scroll { overflow-x: auto; }
  @media print { body { background: #fff; } .hoja { max-width: none; } }
`;

interface Marca { name: string; logo: string | null }

function cabecera(marca: Marca, titulo: string, sub: string): string {
  return `<header>
      <div><h1>${esc(titulo)}</h1><p>${esc(sub)}</p></div>
      ${marca.logo ? `<img src="${esc(marca.logo)}" alt="${esc(marca.name)}">` : `<p>${esc(marca.name)}</p>`}
    </header><div class="acento"></div>`;
}

function paginaSimple(marca: Marca, titulo: string, texto: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>${esc(titulo)}</title><style>${ESTILO}</style></head>
    <body><div class="hoja">${cabecera(marca, titulo, marca.name)}
    <div class="cuerpo"><p class="nota">${esc(texto)}</p></div></div></body></html>`;
}

function statementHtml(
  marca: Marca,
  fila: Record<string, unknown>,
  trades: Trade[],
  cycle: { startedAt: Date | null; startedBy: string; excludedFromPreviousCycles: number },
): string {
  const bruto = trades.reduce((a, t) => a + t.profit, 0);
  const swap = trades.reduce((a, t) => a + t.swap, 0);
  const comision = trades.reduce((a, t) => a + t.commission, 0);
  const neto = bruto + swap + comision;
  const ganadoras = trades.filter((t) => t.profit + t.swap + t.commission > 0).length;

  const filas = trades
    .map((t) => {
      const r = t.profit + t.swap + t.commission;
      return `<tr>
        <td class="num">${t.index + 1}</td>
        <td>${esc(t.position)}</td>
        <td>${esc(t.symbol)}</td>
        <td>${t.type === 'buy' ? 'Buy' : 'Sell'}</td>
        <td class="num">${t.volume.toFixed(2)}</td>
        <td>${cuando(t.openTime)}</td>
        <td class="num">${t.openPrice}</td>
        <td>${cuando(t.closeTime)}</td>
        <td class="num">${t.closePrice}</td>
        <td class="num">${duracion(t.durationMinutes)}</td>
        <td class="num">${money(t.commission)}</td>
        <td class="num">${money(t.swap)}</td>
        <td class="num ${r < 0 ? 'neg' : 'pos'}">${money(t.profit)}</td>
      </tr>`;
    })
    .join('');

  const dato = (label: string, valor: string) =>
    `<div class="dato"><span>${esc(label)}</span><strong>${esc(valor)}</strong></div>`;

  const inicio = cycle.startedAt ? cycle.startedAt.toISOString().slice(0, 10) : 'inicio de la cuenta';
  const porQue = cycle.startedBy === 'retiro_pagado' ? 'último retiro pagado'
    : cycle.startedBy === 'creacion' ? 'creación de la cuenta' : 'sin marca de inicio';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Informe cuenta ${esc(fila.login)} — ${esc(marca.name)}</title>
<style>${ESTILO}</style></head><body><div class="hoja">
${cabecera(marca, `Informe de la cuenta ${esc(fila.login)}`, `${marca.name} · generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`)}
<div class="cuerpo">
  <div class="datos">
    ${dato('Cliente', String(fila.username ?? '—'))}
    ${dato('Correo', String(fila.user_email ?? '—'))}
    ${dato('Cuenta', String(fila.login ?? '—'))}
    ${dato('Programa', String(fila.program_name ?? '—'))}
    ${dato('Retiro solicitado', `$${money(Number(fila.requested_amount ?? 0))}`)}
    ${dato('Fecha de solicitud', fila.requested_date ? String(fila.requested_date).slice(0, 19).replace('T', ' ') : '—')}
    ${dato('Estado en el CRM', String(fila.status ?? '—'))}
    ${dato('Ciclo desde', `${inicio} (${porQue})`)}
  </div>

  <h2>Resumen del ciclo</h2>
  <div class="datos">
    ${dato('Operaciones', String(trades.length))}
    ${dato('Ganadoras', `${ganadoras} de ${trades.length}`)}
    ${dato('Resultado bruto', `$${money(bruto)}`)}
    ${dato('Swap', `$${money(swap)}`)}
    ${dato('Comisiones', `$${money(comision)}`)}
    ${dato('Resultado neto', `$${money(neto)}`)}
  </div>

  <h2>Operaciones del ciclo (${trades.length})</h2>
  <div class="scroll"><table>
    <thead><tr>
      <th>#</th><th>Posición</th><th>Símbolo</th><th>Tipo</th><th class="num">Volumen</th>
      <th>Apertura</th><th class="num">Precio ap.</th><th>Cierre</th><th class="num">Precio ci.</th>
      <th class="num">Duración</th><th class="num">Comisión</th><th class="num">Swap</th><th class="num">Resultado</th>
    </tr></thead>
    <tbody>${filas || '<tr><td colspan="13">La cuenta no tiene operaciones cerradas en este ciclo.</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="10">Totales</td>
      <td class="num">${money(comision)}</td>
      <td class="num">${money(swap)}</td>
      <td class="num ${neto < 0 ? 'neg' : 'pos'}">${money(neto)}</td>
    </tr></tfoot>
  </table></div>

  <p class="nota">
    Las operaciones salen de MetaTrader (mt5_deals), emparejando entrada y salida por PositionID, y son
    las del CICLO VIGENTE: el que arrancó con ${esc(porQue)}.
    ${cycle.excludedFromPreviousCycles > 0
      ? `${cycle.excludedFromPreviousCycles} operación(es) de ciclos anteriores quedaron fuera porque ya se revisaron y ya se pagaron.`
      : ''}
    Este informe muestra lo operado; no aprueba ni rechaza el retiro.
  </p>
</div></div></body></html>`;
}
