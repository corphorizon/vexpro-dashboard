import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { proxiedFetch } from './src/lib/api-integrations/proxy.ts';
const SP = process.env.SP;
function loadEnv(path){const o={};for(const l of readFileSync(path,'utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);if(m)o[m[1]]=m[2];}return o;}
const local=loadEnv('.env.local'); const vercel=loadEnv(`${SP}/.env.vercel.tmp`);
process.env.FIXIE_URL = vercel.FIXIE_URL || '';
const CID='71715987-5479-52c4-a990-c414fb3a9b36';
const r=await fetch(`${local.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/api_credentials?company_id=eq.${CID}&provider=eq.coinsbuy&select=encrypted_secret,iv,auth_tag,extra_config`,{headers:{apikey:local.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${local.SUPABASE_SERVICE_ROLE_KEY}`}});
const [row]=await r.json();
const key=Buffer.from(vercel.API_CREDENTIALS_MASTER_KEY,'base64');
const dec=createDecipheriv('aes-256-gcm',key,Buffer.from(row.iv,'base64'));
dec.setAuthTag(Buffer.from(row.auth_tag,'base64'));
const creds=JSON.parse(Buffer.concat([dec.update(Buffer.from(row.encrypted_secret,'base64')),dec.final()]).toString('utf8'));
const baseUrl=(row.extra_config?.base_url ?? vercel.COINSBUY_BASE_URL).replace(/\/+$/,'');
const tok=await proxiedFetch(`${baseUrl}/token/`,{method:'POST',headers:{'Content-Type':'application/vnd.api+json'},body:JSON.stringify({data:{type:'auth-token',attributes:{client_id:creds.client_id,client_secret:creds.client_secret}}})});
const access=(await tok.json()).data.attributes.access;
// Recorrer páginas y clasificar por op_type; mostrar todos los no-1
const seen={}; const interesting=[];
for (let page=1; page<=12; page++){
  const res=await proxiedFetch(`${baseUrl}/transfer/?page%5Bsize%5D=100&page%5Bnumber%5D=${page}&sort=-id`,{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/vnd.api+json'}});
  const j=await res.json();
  for (const d of (j.data??[])){
    const t=d.attributes.op_type; seen[t]=(seen[t]??0)+1;
    if (t!==1) interesting.push({id:d.id, op:t, st:d.attributes.status, amt:d.attributes.amount, created:d.attributes.created_at, wallet:d.relationships?.wallet?.data?.id, msg:d.attributes.user_message});
  }
  if (!j.links?.next && (j.data??[]).length<100) break;
}
console.log('op_type counts:',seen);
for (const x of interesting.slice(0,40)) console.log(JSON.stringify(x));
