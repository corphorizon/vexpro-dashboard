// Smoke E2E del receptor Pay-Pros contra el dev server local.
// 1) mete una credencial de prueba en el tenant e2e (cifrada con el helper real)
// 2) manda un webhook firmado (variante concat) → espera errorCode 0
// 3) manda el MISMO notifyReference otra vez → idempotente, errorCode 0 sin duplicar
// 4) manda firma falsa → errorCode 1
// 5) verifica filas en api_transactions y paypros_webhook_events
// 6) limpia
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { encryptSecret } from '../src/lib/crypto';
import { computeOutgoingSignature, parseOutgoing, buildIngoingResponse } from '../src/lib/api-integrations/paypros/protocol';

async function main() {
for (const line of readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';

const { data: co } = await admin.from('companies').select('id').eq('subdomain','e2e-test').single();
if (!co) throw new Error('no e2e company');
const companyId = co.id as string;
const signKey = 'sk_test_' + randomBytes(8).toString('hex');
const apiKey  = 'ak_test_' + randomBytes(8).toString('hex');
const token   = randomBytes(32).toString('hex');
const enc = encryptSecret(JSON.stringify({ merchant_id: 'M000000TEST', api_key: apiKey, sign_key: signKey }));
await admin.from('api_credentials').delete().eq('company_id', companyId).eq('provider','paypros');
const { error: insErr } = await admin.from('api_credentials').insert({
  company_id: companyId, provider: 'paypros', encrypted_secret: enc.ciphertext, iv: enc.iv, auth_tag: enc.authTag,
  is_configured: true, last_four: apiKey.slice(-4),
  extra_config: { base_url: 'https://master-api.pay-pros.com/', webhook_token: token },
});
if (insErr) throw insErr;
console.log('credencial de prueba creada, token', token.slice(0,8)+'…');

const nref = 'SMOKE' + Date.now();
const fields = ['2026-08-17T10:15:00', nref, 'BAN0009876236', '150.50', 'USD', '4'];
const sig = computeOutgoingSignature(fields, signKey, 'concat');
const body = [...fields, sig].join('&');
const url = `${BASE}/api/webhooks/paypros/${token}`;

async function post(b: string) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': 'paypros-smoke' }, body: b });
  return { status: r.status, text: await r.text() };
}
const r1 = await post(body);           console.log('1) firmado      →', r1.status, r1.text);
const r2 = await post(body);           console.log('2) reintento    →', r2.status, r2.text);
const bad = [...fields, 'deadbeef'.repeat(8)].join('&');
const r3 = await post(bad);            console.log('3) firma falsa (mismo nref) →', r3.status, r3.text);
const badFresh = [fields[0], nref + 'X', ...fields.slice(2), 'deadbeef'.repeat(8)].join('&');
const r3b = await post(badFresh);      console.log('3b) firma falsa (nref nuevo)→', r3b.status, r3b.text);
const r4 = await post('basura&sin&formato');  console.log('4) ilegible     →', r4.status, r4.text);
const r5 = await fetch(`${BASE}/api/webhooks/paypros/${'0'.repeat(64)}`, { method:'POST', body }); console.log('5) token malo   →', r5.status);

// respuesta esperada de (1): 0&nref&uid&amount&currency&sig(signKey+apiKey)
const parsed = parseOutgoing(body)!;
const expected = buildIngoingResponse(0, parsed, signKey, apiKey, 'concat');
console.log('   ingoing esperado coincide:', r1.text === expected);

const { data: tx } = await admin.from('api_transactions').select('external_id, amount, status, currency, transaction_date').eq('company_id', companyId).eq('provider','paypros');
console.log('api_transactions paypros:', JSON.stringify(tx));
const { data: ev } = await admin.from('paypros_webhook_events').select('notify_reference, signature_valid, status_code, processed_at, error').eq('company_id', companyId).order('received_at');
console.log('webhook_events:', JSON.stringify(ev));

// limpieza
await admin.from('api_transactions').delete().eq('company_id', companyId).eq('provider','paypros');
await admin.from('paypros_webhook_events').delete().eq('company_id', companyId);
await admin.from('api_credentials').delete().eq('company_id', companyId).eq('provider','paypros');
console.log('limpio.');

}
main().catch((e) => { console.error(e); process.exit(1); });
