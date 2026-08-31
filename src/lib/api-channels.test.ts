// ─────────────────────────────────────────────────────────────────────────────
// El registro de canales de TypeScript contra lo que las RPC de SQL conocen.
//
// POR QUÉ ESTE TEST (2026-08-31, auditoría de finanzas, ítem 14)
// Hasta hoy NADA cruzaba el TypeScript con el SQL. Las dos puntas enumeran los
// mismos canales —`BUILTIN_CHANNELS`/`API_CHANNELS` de un lado,
// `get_channel_day_movements` del otro— y se movían por separado. Cuando entró
// Pay-Pros hubo que acordarse de tocar la migración 105 Y el TS; cuando salió
// FairPay del extracto, la migración 108 Y el TS. Nada avisaba si sólo se hacía
// la mitad, y "el canal no devuelve movimientos" se ve igual que "ese día no
// hubo movimientos": el fallo que no da error de §1.2.
//
// El test lee el .sql REAL de supabase/ (la definición vigente de la RPC, que
// es la de la migración más alta que la redefine) y verifica las dos
// direcciones. Es el mismo criterio que la regla G11 de las reglas del
// proyecto: se prueba el TEXTO de la consulta, porque contra una base vacía
// «cero filas» y «la rama no existe» son indistinguibles.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  API_CHANNELS,
  LIVE_BALANCE_CHANNELS,
  NON_RENAMABLE_BUILTIN_CHANNELS,
  PROVIDER_META,
  apiChannelRegistryDrift,
  canRenameChannel,
  providerLabel,
} from './api-channels';
import { API_LEDGER_CHANNELS } from './channel-ledger';
import { MAX_ADJUSTMENT, maxAdjustmentFor, DEFAULT_MAX_ADJUSTMENT } from './channel-ledger-sync';
import { liveBalanceCoverageDrift } from './api-integrations/live-balances';

const SUPABASE_DIR = path.resolve(__dirname, '../../supabase');

/**
 * Cuerpo VIGENTE de una función: el de la migración de número más alto que la
 * define o redefine. Mirar sólo la primera daría por buena una rama que una
 * migración posterior sacó (que es exactamente lo que pasó con 'fairpay').
 */
function latestFunctionBody(fnName: string): { file: string; body: string } {
  const needle = `function public.${fnName}(`;
  const files = readdirSync(SUPABASE_DIR)
    .filter((f) => f.startsWith('migration-') && f.endsWith('.sql'))
    .sort(); // migration-NNN-* → orden lexicográfico = orden numérico (3 dígitos)

  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(SUPABASE_DIR, file), 'utf8');
    const at = sql.indexOf(needle);
    if (at === -1) continue;
    // El cuerpo va entre los dos $function$ que siguen a la firma.
    const open = sql.indexOf('$function$', at);
    const close = sql.indexOf('$function$', open + 10);
    if (open === -1 || close === -1) continue;
    found = { file, body: sql.slice(open + 10, close) };
  }
  if (!found) throw new Error(`No hay ninguna migración que defina ${fnName}`);
  return found;
}

describe('registro de canales: TS ↔ SQL', () => {
  const rpc = latestFunctionBody('get_channel_day_movements');

  it('lee la definición vigente de get_channel_day_movements', () => {
    // Si esto falla, el helper dejó de encontrar el .sql y todo lo de abajo
    // pasaría por vacío — que es peor que fallar.
    expect(rpc.body.length).toBeGreaterThan(200);
    expect(rpc.body).toContain('api_transactions');
  });

  it('cada canal con extracto emite su fila en la RPC', () => {
    for (const ch of API_CHANNELS) {
      if (ch.movementSlugs.length === 0) continue;
      expect(
        rpc.body.includes(`'${ch.key}'::text`) || rpc.body.includes(`'${ch.key}'`),
        `El canal '${ch.key}' declara extracto en API_CHANNELS pero ${rpc.file} no ` +
          `devuelve ninguna fila para él: su libro se asentaría sin depósitos ni retiros.`,
      ).toBe(true);
    }
  });

  it('cada provider slug del registro aparece en la RPC', () => {
    for (const ch of API_CHANNELS) {
      for (const slug of ch.movementSlugs) {
        expect(
          rpc.body.includes(`'${slug}'`),
          `El slug '${slug}' (canal '${ch.key}') no aparece en ${rpc.file}: las filas ` +
            `de ese proveedor no llegan al libro y el ajuste se las come sin nombre.`,
        ).toBe(true);
      }
    }
  });

  it('un canal SIN extracto no tiene rama en la RPC', () => {
    // FairPay: sus filas son del portal de cobros, otro sistema. Si volviera a
    // aparecer en la RPC, el libro asentaría «Depósitos del día» que esa cuenta
    // bancaria nunca recibió (ver la cabecera de channel-ledger.ts).
    for (const ch of API_CHANNELS) {
      if (ch.movementSlugs.length > 0) continue;
      expect(
        rpc.body.includes(`t.provider = '${ch.key}'`),
        `El canal '${ch.key}' está declarado sin extracto (noMovementFeed) pero ` +
          `${rpc.file} lo filtra como proveedor: una de las dos puntas está mal.`,
      ).toBe(false);
    }
  });
});

describe('API_CHANNELS vs API_LEDGER_CHANNELS', () => {
  it('no hay desvío en ninguna de las dos direcciones', () => {
    expect(apiChannelRegistryDrift()).toEqual({
      missingFromRegistry: [],
      unknownChannels: [],
    });
  });

  it('todo canal de libro automático tiene un tope de ajuste EXPLÍCITO', () => {
    // Sin esto, un built-in `auto` nuevo caía al DEFAULT_MAX_ADJUSTMENT de
    // 1.000 y su libro se congelaba la primera noche que se moviera más de mil
    // dólares — el caso Coinsbuy con tope 500, diez días y $91.756,14.
    for (const key of API_LEDGER_CHANNELS) {
      expect(MAX_ADJUSTMENT[key], `Canal '${key}' sin tope propio`).toBeTypeOf('number');
      expect(maxAdjustmentFor(key)).not.toBe(DEFAULT_MAX_ADJUSTMENT);
    }
  });

  it('los topes son los medidos en producción', () => {
    // Fijados: el ítem 14 movió DE DÓNDE salen, no cuánto valen.
    expect(MAX_ADJUSTMENT).toEqual({
      coinsbuy: 150_000,
      unipayment: 25_000,
      fairpay: 25_000,
      paypros: 5_000,
    });
  });
});

describe('saldo en vivo', () => {
  it('todo canal `liveBalance` tiene fetcher, y no hay fetchers huérfanos', () => {
    expect(liveBalanceCoverageDrift()).toEqual({
      missingFetchers: [],
      orphanFetchers: [],
    });
  });

  it('Pay-Pros y FairPay se refrescan en vivo', () => {
    // El bug concreto: Pay-Pros con $39.944 mostraba el saldo de anoche
    // mientras UniPayment con $21 se refrescaba.
    expect(LIVE_BALANCE_CHANNELS).toContain('paypros');
    expect(LIVE_BALANCE_CHANNELS).toContain('fairpay');
  });
});

describe('canRenameChannel', () => {
  it('ningún canal de proveedor externo se puede renombrar', () => {
    for (const key of API_LEDGER_CHANNELS) {
      expect(canRenameChannel(key, false), `'${key}' no debería ser renombrable`).toBe(false);
    }
    // Los cuatro, no los dos de la lista vieja.
    expect([...NON_RENAMABLE_BUILTIN_CHANNELS].sort()).toEqual([
      'coinsbuy',
      'fairpay',
      'paypros',
      'unipayment',
    ]);
  });

  it('los `auto` derivados y los manuales sí', () => {
    // Su nombre es nuestro, no el de ningún proveedor.
    expect(canRenameChannel('liquidez', false)).toBe(true);
    expect(canRenameChannel('inversiones', false)).toBe(true);
    expect(canRenameChannel('wallet_externa', false)).toBe(true);
    expect(canRenameChannel('otros', false)).toBe(true);
    expect(canRenameChannel('custom_abc', true)).toBe(true);
  });
});

describe('providerLabel', () => {
  it('Coinsbuy es UN proveedor aunque reporte dos datasets', () => {
    expect(providerLabel('coinsbuy-deposits')).toBe('Coinsbuy');
    expect(providerLabel('coinsbuy-withdrawals')).toBe('Coinsbuy');
  });

  it('Pay-Pros tiene nombre — el Record viejo no lo tenía', () => {
    expect(providerLabel('paypros')).toBe('Pay-Pros');
  });

  it('lo que no es un proveedor de pagos no se pierde', () => {
    expect(providerLabel('orion_crm')).toBe('Orion CRM');
    expect(providerLabel('lo-que-sea')).toBe('lo-que-sea');
  });

  it('cada slug tiene etiqueta de tarjeta y color', () => {
    for (const [slug, meta] of Object.entries(PROVIDER_META)) {
      expect(meta.cardLabel, slug).toBeTruthy();
      expect(meta.accent, slug).toBeTruthy();
    }
  });
});
