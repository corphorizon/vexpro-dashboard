// ─────────────────────────────────────────────────────────────────────────────
// Tope de ajuste del libro por canal.
//
// El tope es lo único que separa "el libro cerró contra el saldo real" de "el
// libro se tragó un dato roto". Con la wallet on-chain dejó de poder vivir en
// un Record por clave: su canal puede ser `wallet_externa` o un `custom_<uuid>`
// distinto en cada empresa.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ADJUSTMENT,
  MAX_ADJUSTMENT,
  ONCHAIN_MAX_ADJUSTMENT,
  RECOVERY_AFTER_DAYS,
  maxAdjustmentFor,
  syncChannelLedgerDay,
} from './channel-ledger-sync';
import { API_LEDGER_CHANNELS, AUTO_CATEGORIES } from './channel-ledger';

describe('maxAdjustmentFor', () => {
  it('respeta el tope propio de cada canal built-in', () => {
    expect(maxAdjustmentFor('coinsbuy')).toBe(MAX_ADJUSTMENT.coinsbuy);
    expect(maxAdjustmentFor('unipayment')).toBe(MAX_ADJUSTMENT.unipayment);
    expect(maxAdjustmentFor('paypros')).toBe(MAX_ADJUSTMENT.paypros);
  });

  it('un canal manual cualquiera se queda con el default conservador', () => {
    expect(maxAdjustmentFor('custom_1234')).toBe(DEFAULT_MAX_ADJUSTMENT);
    expect(maxAdjustmentFor('wallet_externa')).toBe(DEFAULT_MAX_ADJUSTMENT);
  });

  it('el MISMO canal, marcado on-chain, sube al tope de cadena', () => {
    // Es exactamente el caso de Vex Pro: `wallet_externa` deja de ser manual
    // cuando se le cargan direcciones, y su movimiento diario real (fees de
    // gas + variación de precio + redes sin historial) revienta los $1.000.
    expect(maxAdjustmentFor('wallet_externa', { onchain: true })).toBe(ONCHAIN_MAX_ADJUSTMENT);
    expect(maxAdjustmentFor('custom_1234', { onchain: true })).toBe(ONCHAIN_MAX_ADJUSTMENT);
  });

  it('un canal con tope propio NO se lo pierde por ser on-chain', () => {
    // Si algún día Coinsbuy pasara por este camino, su tope estricto manda:
    // ahí el ajuste son comisiones de red de $1-4 y aflojarlo taparía un bug.
    expect(maxAdjustmentFor('coinsbuy', { onchain: true })).toBe(MAX_ADJUSTMENT.coinsbuy);
  });

  it('el tope on-chain cubre el salto del alta de Vex Pro (≈ −497)', () => {
    // 17.613 cargado a mano → ~17.116 reales. Si el tope no lo cubriera, el
    // primer asiento abortaría y la wallet nunca arrancaría.
    expect(ONCHAIN_MAX_ADJUSTMENT).toBeGreaterThan(600);
  });

  it('el tope de FairPay cubre su salto real de agosto (+6.747,05)', () => {
    // FairPay no tiene extracto: la variación ENTERA del saldo cae en la línea
    // de conciliación, todos los días. Con el default de 1.000 el asiento del
    // 2026-08-17 (0 → 6.747,05) habría abortado y el canal seguiría en $0,00,
    // que es justo el síntoma que este trabajo vino a arreglar.
    expect(maxAdjustmentFor('fairpay')).toBe(MAX_ADJUSTMENT.fairpay);
    expect(maxAdjustmentFor('fairpay')).toBeGreaterThan(6_747.05);
    expect(maxAdjustmentFor('fairpay')).toBeGreaterThan(DEFAULT_MAX_ADJUSTMENT);
  });

  it('todo canal de libro automático tiene tope propio, no el default', () => {
    // Itera el registro: un canal automático nuevo que se olvide de su tope
    // rompe acá en vez de abortar todas las noches en producción.
    for (const key of API_LEDGER_CHANNELS) {
      expect(MAX_ADJUSTMENT[key]).toBeDefined();
      expect(maxAdjustmentFor(key)).not.toBe(DEFAULT_MAX_ADJUSTMENT);
    }
  });

  it('el tope de Coinsbuy cubre el peor residuo MEDIDO (±103.962), no la comisión de red vieja', () => {
    // El 500 original describía un canal de UNA wallet con fees de $1-4/día.
    // Hoy agrega 4 wallets fijadas con internas de $5.000-50.000/día y los
    // residuos medidos entre el 21 y el 31/08 van de ±6.700 a ±103.962.
    expect(maxAdjustmentFor('coinsbuy')).toBeGreaterThan(103_962);
    // Y sigue siendo menos de la mitad del saldo real del canal (335.835,65):
    // un día que mueva más que esto no es una comisión, es un dato roto.
    expect(maxAdjustmentFor('coinsbuy')).toBeLessThan(335_835.65 / 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EL GUARD NO PUEDE CONGELAR EL LIBRO PARA SIEMPRE
//
// Caso real que estos tests fijan (Coinsbuy, 2026-08): el 21/08 el ajuste real
// (−8.478,29) superó un tope de 500 escrito cuando el canal tenía UNA wallet y
// comisiones de red de $1-4/día. El asiento abortó, y como abortar no deja
// estado, cada noche siguiente comparó contra el saldo del 20/08 y volvió a
// superar el tope: 10 días, 11 avisos, cero recuperación, $91.756,14 de brecha.
//
// Y el otro extremo, UniPayment: cuando por fin entró bajo el tope, asentó UN
// «Ajuste de conciliación» de −21.740,51 que eran SEIS días de movimientos.
// El libro cuadraba contando una historia falsa — el peor tipo de dato malo.
// ─────────────────────────────────────────────────────────────────────────────

type Line = {
  entry_date: string; kind: string; concept: string; category: string;
  amount: number; notes: string | null;
};

/**
 * Admin de mentira con SOLO lo que toca `syncChannelLedgerDay`. Se prueba la
 * decisión, no Supabase: las dos RPC y las dos lecturas devuelven lo que se le
 * pase, y las líneas escritas quedan en `written`.
 */
function fakeAdmin(opts: {
  priorBalance: number | null;
  /** Último día con asiento 'api' anterior a la fecha. null = ninguno. */
  lastPosted: string | null;
  movements?: { deposits: number; withdrawals: number; internal: number };
  channelKey?: string;
}) {
  const channelKey = opts.channelKey ?? 'coinsbuy';
  const written: Line[] = [];

  // Builder encadenable Y thenable: la lectura de líneas manuales se awaitea
  // directo y la del último asiento termina en `.limit(1)`.
  const builder = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'lt', 'order']) self[m] = () => self;
    self.limit = () => Promise.resolve({ data: rows, error: null });
    self.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res);
    return self;
  };

  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'get_channel_ledger_balances') {
        return Promise.resolve({
          data:
            opts.priorBalance === null
              ? []
              : [{ channel_key: channelKey, balance: opts.priorBalance }],
          error: null,
        });
      }
      if (name === 'get_channel_day_movements') {
        return Promise.resolve({
          data: [
            {
              channel_key: channelKey,
              ...(opts.movements ?? { deposits: 0, withdrawals: 0, internal: 0 }),
            },
          ],
          error: null,
        });
      }
      if (name === 'replace_channel_ledger_day') {
        written.push(...((args.p_lines as Line[]) ?? []));
        return Promise.resolve({ error: null });
      }
      throw new Error(`RPC inesperada: ${name}`);
    },
    from: () => ({
      // Las dos lecturas de `channel_ledger_entries` se distinguen por columna.
      select: (cols: string) =>
        builder(cols === 'entry_date' && opts.lastPosted ? [{ entry_date: opts.lastPosted }] : []),
      insert: () => Promise.resolve({ error: null }),
    }),
  };

  // El shape del cliente real es mucho más grande; acá alcanza con lo usado.
  return { admin: admin as unknown as Parameters<typeof syncChannelLedgerDay>[0], written };
}

describe('el guard del libro se destraba solo en vez de congelar el canal', () => {
  it('día normal: un ajuste dentro del tope se asienta como «Ajuste de conciliación»', async () => {
    const { admin, written } = fakeAdmin({ priorBalance: 100_000, lastPosted: '2026-08-20' });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-21', 99_000);

    expect(res.error).toBeUndefined();
    expect(res.daysCovered).toBe(1);
    expect(res.forced).toBeUndefined();
    expect(written).toHaveLength(1);
    expect(written[0].category).toBe(AUTO_CATEGORIES.adjustment);
    expect(written[0].amount).toBeCloseTo(1_000, 2);
  });

  it('el 21/08 REAL de Coinsbuy (−8.478,29) ya no aborta con el tope recalibrado', async () => {
    // Con el tope viejo de 500 esto devolvía error y arrancaba el
    // congelamiento de 10 días. Es la regresión que este número compra.
    const { admin, written } = fakeAdmin({ priorBalance: 252_557.8, lastPosted: '2026-08-20' });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-21', 244_079.51);

    expect(res.error).toBeUndefined();
    expect(res.adjustment).toBeCloseTo(-8_478.29, 2);
    expect(written[0].kind).toBe('out');
  });

  it('un día anómalo aislado SIGUE abortando: el guard no se desactivó', async () => {
    const { admin, written } = fakeAdmin({ priorBalance: 100_000, lastPosted: '2026-08-20' });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-21', 900_000);

    expect(res.error).toMatch(/fuera de rango/);
    expect(written).toHaveLength(0);
    expect(res.daysCovered).toBe(1);
  });

  it('N días abortados: al llegar a RECOVERY_AFTER_DAYS se asienta igual, rotulado y marcado', async () => {
    // Dos noches abortadas (21 y 22) ⇒ el 23 el asiento cubre 3 días.
    const { admin, written } = fakeAdmin({ priorBalance: 100_000, lastPosted: '2026-08-20' });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-23', 900_000);

    expect(res.error).toBeUndefined();
    expect(res.daysCovered).toBe(RECOVERY_AFTER_DAYS);
    expect(res.forced).toBe(true);
    expect(written).toHaveLength(1);
    // NO es un ajuste de un día: categoría propia, y las fechas en el texto.
    expect(written[0].category).toBe(AUTO_CATEGORIES.regularization);
    expect(written[0].concept).toContain('3 días');
    expect(written[0].concept).toContain('2026-08-21');
    expect(written[0].concept).toContain('2026-08-23');
    expect(written[0].notes).toContain('NO es el ');
    expect(written[0].notes).toContain('2026-08-23');
    expect(written[0].notes).toContain('backfill-channel-ledger');
  });

  it('EL CASO UNIPAYMENT: un residuo de 6 días nunca se asienta como el ajuste de un día', async () => {
    // Bajo el tope escalado, así que ni siquiera hace falta forzarlo — lo que
    // se fija acá es el ROTULADO: −21.740,51 acumulados no pueden salir con
    // el nombre «Ajuste de conciliación» fechados en un solo día.
    const { admin, written } = fakeAdmin({
      priorBalance: 50_000,
      lastPosted: '2026-08-14',
      channelKey: 'unipayment',
    });
    const res = await syncChannelLedgerDay(admin, 'c1', 'unipayment', '2026-08-20', 28_259.49);

    expect(res.error).toBeUndefined();
    expect(res.daysCovered).toBe(6);
    expect(res.forced).toBeUndefined();
    expect(res.adjustment).toBeCloseTo(-21_740.51, 2);
    expect(written[0].category).toBe(AUTO_CATEGORIES.regularization);
    expect(written[0].category).not.toBe(AUTO_CATEGORIES.adjustment);
    expect(written[0].concept).toContain('6 días');
    expect(written[0].notes).toContain('2026-08-15');
    expect(written[0].notes).toContain('2026-08-19');
  });

  it('el tope se compara contra los días que el asiento cubre, no contra uno', async () => {
    // 3 días × 25.000 = 75.000. Un residuo de 60.000 pasa acumulado y
    // habría abortado si se lo midiera como si fuera de un solo día.
    const { admin, written } = fakeAdmin({
      priorBalance: 100_000,
      lastPosted: '2026-08-20',
      channelKey: 'unipayment',
    });
    const res = await syncChannelLedgerDay(admin, 'c1', 'unipayment', '2026-08-23', 40_000);

    expect(res.error).toBeUndefined();
    expect(res.forced).toBeUndefined();
    expect(written[0].category).toBe(AUTO_CATEGORIES.regularization);
  });

  it('sin saldo previo abre el libro y no inventa una regularización', async () => {
    const { admin, written } = fakeAdmin({ priorBalance: null, lastPosted: null });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-21', 1_234);

    expect(res.bootstrapped).toBe(true);
    expect(written).toHaveLength(0);
  });

  it('libro sin ningún asiento «api» previo: se asume 1 día, no un hueco de largo desconocido', async () => {
    const { admin, written } = fakeAdmin({ priorBalance: 100_000, lastPosted: null });
    const res = await syncChannelLedgerDay(admin, 'c1', 'coinsbuy', '2026-08-21', 99_000);

    expect(res.daysCovered).toBe(1);
    expect(written[0].category).toBe(AUTO_CATEGORIES.adjustment);
  });
});
