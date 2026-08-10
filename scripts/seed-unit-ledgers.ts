// Sube los libros "Balance Horizon" y "Balance Exura" del Sheet a los libros
// de ubicaciones del dashboard, asignados a sus unidades de negocio.
//
//   npx tsx scripts/seed-unit-ledgers.ts <libros.json> [--apply]
//
// IDEMPOTENTE: borra y re-inserta los asientos de las dos claves fijas.
// El JSON viene del parser (cuadrado al centavo contra la columna TOTAL de la
// hoja: Horizon 21.410,00 · Exura 49.944,69).

import { readFileSync } from 'fs';
import { resolve } from 'path';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

interface Row { date: string; detail: string; in: number; out: number }

const BOOKS: Array<{ jsonKey: 'horizon' | 'exura'; channelKey: string; label: string; unitName: string }> = [
  { jsonKey: 'horizon', channelKey: 'custom_balance_horizon', label: 'Balance Horizon', unitName: 'Horizon Consulting' },
  { jsonKey: 'exura',   channelKey: 'custom_balance_exura',   label: 'Balance Exura',   unitName: 'Exura Prime' },
];

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) { console.error('Uso: npx tsx scripts/seed-unit-ledgers.ts <libros.json> [--apply]'); process.exit(1); }
  const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Row[]>;

  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();

  const { data: company } = await admin.from('companies').select('id, name').eq('name', 'Horizon').single();
  if (!company) throw new Error('Empresa Horizon no encontrada');
  const { data: units } = await admin.from('business_units').select('id, name').eq('company_id', company.id);

  console.log(apply ? '*** APLICANDO ***' : '--- ENSAYO (sin --apply no escribe) ---');

  for (const book of BOOKS) {
    const rows = data[book.jsonKey];
    const unit = (units ?? []).find((u) => u.name === book.unitName);
    if (!unit) throw new Error(`Unidad "${book.unitName}" no existe`);
    const saldo = rows.reduce((s, r) => s + r.in - r.out, 0);
    console.log(`${book.label}: ${rows.length} movimientos → saldo ${saldo.toFixed(2)} · unidad ${unit.name}`);
    if (!apply) continue;

    // Ubicación (tipo cash: es la caja operativa de la unidad).
    await admin.from('channel_configs').upsert({
      company_id: company.id, channel_key: book.channelKey, custom_label: book.label,
      channel_type: 'manual', is_custom: true, is_visible: true,
      location_type: 'cash', business_unit_id: unit.id,
      sort_order: book.jsonKey === 'horizon' ? 0 : 1,
    }, { onConflict: 'company_id,channel_key' });
    await admin.from('location_business_units').upsert({
      company_id: company.id, channel_key: book.channelKey, business_unit_id: unit.id, share: 1,
    }, { onConflict: 'company_id,channel_key,business_unit_id' });

    await admin.from('channel_ledger_entries').delete()
      .eq('company_id', company.id).eq('channel_key', book.channelKey);

    const entries = rows.map((r, i) => {
      const opening = i === 0 && /balance inicial/i.test(r.detail);
      return {
        company_id: company.id, channel_key: book.channelKey, entry_date: r.date,
        kind: opening ? 'opening' : (r.in > 0 ? 'in' : 'out'),
        source: 'manual',
        concept: r.detail.slice(0, 200),
        category: opening ? 'opening' : null,
        amount: opening ? r.in : (r.in > 0 ? r.in : r.out),
      };
    // Una fila con entrada Y salida a la vez no existe en la hoja, pero por
    // las dudas se partiría en dos: acá se valida que no haga falta.
    });
    for (const [i, r] of rows.entries()) {
      if (r.in > 0 && r.out > 0) throw new Error(`Fila ${i} tiene entrada y salida a la vez: ${r.detail}`);
    }

    for (let i = 0; i < entries.length; i += 100) {
      const { error } = await admin.from('channel_ledger_entries').insert(entries.slice(i, i + 100));
      if (error) throw new Error(`${book.label} lote ${i}: ${error.message}`);
    }
    console.log(`  ✓ ${entries.length} asientos insertados`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
