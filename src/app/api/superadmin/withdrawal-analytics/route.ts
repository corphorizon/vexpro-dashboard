import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';

// ─────────────────────────────────────────────────────────────────────────────
// Analítica de retiros del CRM (Orion Mongo) — SOLO AGREGADOS.
//
// Objetivo: caracterizar el histórico de retiros para DISEÑAR el módulo de
// revisión y el score de aprobación sobre datos REALES, no supuestos. Todo lo
// que sale son conteos, sumas y buckets: NUNCA un userId, monto individual,
// dirección ni nombre. Solo lectura, solo superadmin, una pasada con $facet.
//
// Señales que caracteriza (de la colección `withdrawals`, que ya trae
// denormalizados totalDepositLifetime / totalWithdrawLifetime por documento):
//   · vocabulario de status y type (el espacio de etiquetas del score)
//   · reparto por procesador, moneda/red
//   · monto solicitado en buckets, cruzado con status
//   · posición neta (depositado − retirado de por vida) en buckets × status
//   · ratio retirado/depositado × status
//   · antigüedad de la cola pendiente
//   · retiros por mes × status
//   · tiempo de autorización (autorizado − solicitado) percentiles
//
// La conexión sale DIRECTA de Vercel (sin Fixie); Atlas del broker ya la
// aceptó en los probes. Se borra cuando el módulo esté construido.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TIMEOUT_MS = 25_000;

// Buckets de monto (USD) y de posición neta. En centavos-agnóstico: el CRM
// guarda montos como número; asumimos USD (transactionAmount ya viene en la
// moneda de liquidación del retiro).
// Cada colección nombra sus campos distinto. Sin este mapa, consultar
// `deposits` con los nombres de `withdrawals` devuelve todo null (pasó en la
// primera corrida: 39.413 docs y cero señal).
interface FieldMap {
  status: string; type: string; amount: string; requested: string;
  fee: string | null; date: string; processor: string | null;
  netDeposit: string | null; netWithdraw: string | null; authDate: string | null;
}
const FIELD_MAPS: Record<string, FieldMap> = {
  withdrawals: {
    status: 'status', type: 'type', amount: 'transactionAmount', requested: 'requestedAmount',
    fee: 'fee', date: 'requestedDate', processor: 'processor',
    netDeposit: 'totalDepositLifetime', netWithdraw: 'totalWithdrawLifetime', authDate: 'authorizedDate',
  },
  deposits: {
    status: 'depositStatus', type: 'depositType', amount: 'amountPaid', requested: 'depositValue',
    fee: null, date: 'depositDate', processor: 'walletType',
    netDeposit: null, netWithdraw: null, authDate: null,
  },
  transactions: {
    status: 'transactionStatus', type: 'transactionType', amount: 'transactionValue', requested: 'transactionValue',
    fee: null, date: 'transactionDate', processor: null,
    netDeposit: null, netWithdraw: null, authDate: null,
  },
};
const DEFAULT_MAP: FieldMap = FIELD_MAPS.withdrawals;

const AMOUNT_BOUNDARIES = [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000];
const NET_BOUNDARIES = [-1e12, -10000, -1000, -100, 0, 100, 1000, 10000, 1e12];

export async function GET(request: NextRequest) {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const companyId = request.nextUrl.searchParams.get('company_id');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ success: false, error: 'company_id requerido' }, { status: 400 });
  }
  const collection = (request.nextUrl.searchParams.get('collection') ?? 'withdrawals').replace(/[^a-z0-9_]/gi, '');

  const startedAt = Date.now();
  try {
    const payload = await withTimeout(
      withOrionMongo(companyId, async ({ db }) => {
        const coll = db.collection(collection);
        const F = FIELD_MAPS[collection] ?? DEFAULT_MAP;
        const total = await coll.estimatedDocumentCount();

        // Redondea a 2 decimales dentro del pipeline para que las sumas no
        // arrastren ruido de float.
        const money = (field: string) => ({ $round: [{ $ifNull: [field, 0] }, 2] });

        const rows = await coll
          .aggregate(
            [
              {
                $facet: {
                  // 1) Vocabulario de status.
                  byStatus: [
                    { $group: { _id: `$${F.status}`, n: { $sum: 1 }, sumTx: { $sum: money(`$${F.amount}`) }, sumReq: { $sum: money(`$${F.requested}`) }, sumFee: { $sum: F.fee ? money(`$${F.fee}`) : 0 } } },
                    { $sort: { n: -1 } },
                  ],
                  // 2) Vocabulario de type.
                  byType: [{ $group: { _id: `$${F.type}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }],
                  // 3) status × type.
                  byStatusType: [{ $group: { _id: { status: `$${F.status}`, type: `$${F.type}` }, n: { $sum: 1 }, sumTx: { $sum: money(`$${F.amount}`) } } }, { $sort: { n: -1 } }, { $limit: 40 }],
                  // 4) Procesador × status.
                  byProcessorStatus: [{ $group: { _id: { processor: F.processor ? `$${F.processor}` : 'n/a', status: `$${F.status}` }, n: { $sum: 1 }, sumTx: { $sum: money(`$${F.amount}`) } } }, { $sort: { n: -1 } }, { $limit: 40 }],
                  // 5) Moneda / red.
                  byCoin: [{ $group: { _id: { coin: '$coin', network: '$network' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 30 }],
                  // 6) Monto solicitado en buckets × status.
                  amountByStatus: [
                    {
                      $bucket: {
                        groupBy: { $ifNull: [`$${F.requested}`, 0] },
                        boundaries: AMOUNT_BOUNDARIES,
                        default: '10000+',
                        output: { n: { $sum: 1 }, byStatus: { $push: `$${F.status}` } },
                      },
                    },
                  ],
                  // 7) Posición neta (depositado − retirado de por vida) × status.
                  netByStatus: [
                    { $addFields: { _net: F.netDeposit && F.netWithdraw ? { $subtract: [{ $ifNull: [`$${F.netDeposit}`, 0] }, { $ifNull: [`$${F.netWithdraw}`, 0] }] } : 0 } },
                    {
                      $bucket: {
                        groupBy: '$_net',
                        boundaries: NET_BOUNDARIES,
                        default: 'other',
                        output: { n: { $sum: 1 }, statuses: { $push: `$${F.status}` } },
                      },
                    },
                  ],
                  // 8) Ratio retirado/depositado en tramos × status.
                  ratioByStatus: [
                    { $addFields: { _ratio: F.netDeposit && F.netWithdraw ? { $cond: [{ $gt: [{ $ifNull: [`$${F.netDeposit}`, 0] }, 0] }, { $divide: [{ $ifNull: [`$${F.netWithdraw}`, 0] }, `$${F.netDeposit}`] }, -1] } : -1 } },
                    {
                      $bucket: {
                        groupBy: '$_ratio',
                        boundaries: [-1, 0, 0.25, 0.5, 0.75, 0.9, 1.0, 1.5, 1e9],
                        default: 'other',
                        output: { n: { $sum: 1 }, statuses: { $push: '$status' } },
                      },
                    },
                  ],
                  // 9) Estadísticos de monto.
                  amountStats: [{ $group: { _id: null, min: { $min: `$${F.requested}` }, max: { $max: `$${F.requested}` }, avg: { $avg: `$${F.requested}` }, count: { $sum: 1 } } }],
                  // 10) Retiros por mes × status.
                  monthly: [
                    { $match: { [F.date]: { $type: 'date' } } },
                    { $group: { _id: { y: { $year: `$${F.date}` }, m: { $month: `$${F.date}` }, status: `$${F.status}` }, n: { $sum: 1 }, sumTx: { $sum: money(`$${F.amount}`) } } },
                    { $sort: { '_id.y': -1, '_id.m': -1 } },
                    { $limit: 60 },
                  ],
                  // 11) Tiempo de autorización (días) para los que tienen ambas fechas.
                  authLatency: [
                    { $match: F.authDate ? { [F.date]: { $type: 'date' }, [F.authDate]: { $type: 'date' } } : { _nonexistent_: true } },
                    { $addFields: { _days: F.authDate ? { $divide: [{ $subtract: [`$${F.authDate}`, `$${F.date}`] }, 86400000] } : 0 } },
                    { $group: { _id: null, n: { $sum: 1 }, avgDays: { $avg: '$_days' }, maxDays: { $max: '$_days' } } },
                  ],
                },
              },
            ],
            { allowDiskUse: false, maxTimeMS: 20_000 },
          )
          .toArray();

        const facet = rows[0] ?? {};

        // Compacta los $push de status en conteos {status: n} para no devolver
        // arrays gigantes.
        const tally = (arr: unknown): Record<string, number> => {
          const out: Record<string, number> = {};
          if (Array.isArray(arr)) for (const s of arr) { const k = String(s ?? 'null'); out[k] = (out[k] ?? 0) + 1; }
          return out;
        };
        const compact = (bucketRows: unknown, pushKey: string) =>
          (Array.isArray(bucketRows) ? bucketRows : []).map((r) => {
            const row = r as Record<string, unknown>;
            const { [pushKey]: pushed, ...rest } = row;
            return { ...rest, statuses: tally(pushed) };
          });

        return {
          success: true as const,
          collection,
          fieldMap: F,
          totalDocs: total,
          byStatus: facet.byStatus ?? [],
          byType: facet.byType ?? [],
          byStatusType: facet.byStatusType ?? [],
          byProcessorStatus: facet.byProcessorStatus ?? [],
          byCoin: facet.byCoin ?? [],
          amountByStatus: compact(facet.amountByStatus, 'byStatus'),
          netByStatus: compact(facet.netByStatus, 'statuses'),
          ratioByStatus: compact(facet.ratioByStatus, 'statuses'),
          amountStats: (facet.amountStats as unknown[])?.[0] ?? null,
          monthly: facet.monthly ?? [],
          authLatency: (facet.authLatency as unknown[])?.[0] ?? null,
          elapsedMs: Date.now() - startedAt,
        };
      }),
      TIMEOUT_MS,
    );
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { success: false, connected: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - startedAt },
      { status: 200 },
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`La analítica superó los ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
