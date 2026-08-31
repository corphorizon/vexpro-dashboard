// ─────────────────────────────────────────────────────────────────────────────
// «Cargado y verificado en cero» ≠ «nunca cargado» — depósitos y retiros.
// Auditoría de finanzas, ítem 21 (migración 110).
//
// Dos capas, las dos necesarias:
//   1. El CLIENTE no puede filtrar los ceros antes de mandarlos: si los tira
//      acá, la RPC ni se entera de que existían y el arreglo del servidor no
//      sirve para nada.
//   2. La RPC tiene que ser SIMÉTRICA (lee el estado previo ANTES del delete y
//      lo usa en el INSERT). Se prueba el TEXTO del archivo, como manda G11 y
//      como ya hace la migración 073 en income-lines.test.ts: un test contra la
//      base pasaría igual el día que alguien reescriba la función sin la rama.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  withActiveCompany: (url: string) => url,
}));

import { upsertDeposits, upsertWithdrawals } from './supabase/mutations';

/** El payload `rows` del último POST a /api/admin/data. */
function lastRows(): Array<Record<string, unknown>> {
  const [, init] = apiFetch.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(init.body).rows;
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
});

describe('el cliente manda los ceros (no los filtra)', () => {
  it('un depósito puesto en cero viaja al servidor', async () => {
    await upsertDeposits('co', 'per', [
      { channel: 'coinsbuy', amount: 12_345 },
      { channel: 'other', amount: 0 },
    ]);
    expect(lastRows()).toEqual([
      { channel: 'coinsbuy', amount: 12_345 },
      { channel: 'other', amount: 0 },
    ]);
  });

  it('un retiro puesto en cero viaja al servidor', async () => {
    await upsertWithdrawals('co', 'per', [
      { category: 'broker', amount: 5_511 },
      { category: 'prop_firm', amount: 0 },
    ]);
    expect(lastRows()).toEqual([
      { category: 'broker', amount: 5_511, description: null },
      { category: 'prop_firm', amount: 0, description: null },
    ]);
  });

  it('la consolidación por categoría (migr. 065) no se come el cero', async () => {
    // Dos filas de la misma categoría, las dos en cero: se consolidan en UNA,
    // y esa una sigue siendo un cero explícito, no una fila desaparecida.
    await upsertWithdrawals('co', 'per', [
      { category: 'other', amount: 0 },
      { category: 'other', amount: 0 },
    ]);
    expect(lastRows()).toEqual([{ category: 'other', amount: 0, description: null }]);
  });
});

describe('migración 110 — la RPC preserva el cero que ya existía', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migration-110-preservar-el-cero-explicito.sql'),
    'utf8',
  );

  for (const fn of ['replace_period_deposits', 'replace_period_withdrawals']) {
    describe(fn, () => {
      // El cuerpo de esta función, aislado del resto del archivo.
      const body = sql.slice(
        sql.indexOf(`create or replace function public.${fn}`),
        sql.indexOf(`create or replace function public.${fn}`) +
          sql.slice(sql.indexOf(`create or replace function public.${fn}`)).indexOf('end; $$;'),
      );

      it('lee las claves existentes ANTES del delete', () => {
        const readIdx = body.indexOf('into v_existing');
        const deleteIdx = body.indexOf('delete from public.');
        expect(readIdx).toBeGreaterThan(-1);
        expect(deleteIdx).toBeGreaterThan(-1);
        expect(readIdx).toBeLessThan(deleteIdx);
      });

      it('el INSERT acepta un 0 cuando la clave ya existía', () => {
        expect(body).toMatch(/> 0\s*\n\s*or \(r->>'(channel|category)'\) = any\(v_existing\)/);
      });

      it('sigue sin CREAR filas en cero para claves nuevas', () => {
        // El `> 0` tiene que seguir ahí: sin él, /upload crearía una fila en
        // cero por cada canal de la lista fija en el primer guardado del mes.
        expect(body).toMatch(/coalesce\(\(r->>'amount'\)::numeric, 0\) > 0/);
      });

      it('conserva el guard de autorización', () => {
        expect(body).toMatch(/auth\.role\(\) = 'authenticated' and not public\.auth_can_edit/);
      });
    });
  }

  it('conserva los grants de la 044 (nada de anon ni public)', () => {
    expect(sql).toMatch(/revoke all on function public\.replace_period_deposits\(uuid, uuid, jsonb\) from public, anon;/);
    expect(sql).toMatch(/revoke all on function public\.replace_period_withdrawals\(uuid, uuid, jsonb\) from public, anon;/);
    expect(sql).not.toMatch(/grant execute on function public\.replace_period_\w+\(uuid, uuid, jsonb\) to anon/);
  });
});
