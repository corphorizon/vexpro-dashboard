'use client';

import { useState } from 'react';
import { Download, Filter, MoreHorizontal } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Money } from '@/components/ui/money';
import { StatusBadge, STATUS_KINDS, type StatusKind } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { DistributionBar } from '@/components/ui/distribution-bar';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

// Muestra de desarrollo: datos INVENTADOS, nada de esto sale de la base.
// Fecha fija para que «hace X» no dependa del reloj de quien la abre.
const NOW = Date.parse('2026-10-12T15:00:00Z');
const HOURS = 3_600_000;

interface Channel {
  id: string;
  name: string;
  group: 'gateways' | 'exchanges' | 'banks';
  source: string;
  balance: number | null;
  syncedAt: number;
  stale?: boolean;
}

const CHANNELS: Channel[] = [
  { id: 'coinsbuy', name: 'Coinsbuy', group: 'gateways', source: 'API', balance: 48_210.55, syncedAt: NOW - 4 * 60_000 },
  { id: 'fairpay', name: 'FairPay', group: 'gateways', source: 'API', balance: 12_904.1, syncedAt: NOW - 26 * HOURS, stale: true },
  { id: 'unipayment', name: 'UniPayment', group: 'gateways', source: 'API', balance: null, syncedAt: NOW - 3 * HOURS },
  { id: 'paypros', name: 'Pay-Pros', group: 'gateways', source: 'API', balance: 3_120, syncedAt: NOW - 9 * 60_000 },
  { id: 'binance', name: 'Binance', group: 'exchanges', source: 'On-chain', balance: 61_480.02, syncedAt: NOW - 2 * 60_000 },
  { id: 'kraken', name: 'Kraken', group: 'exchanges', source: 'Manual', balance: 940.5, syncedAt: NOW - 41 * 24 * HOURS, stale: true },
  { id: 'santander', name: 'Santander', group: 'banks', source: 'Manual', balance: 22_005, syncedAt: NOW - 20 * HOURS },
  { id: 'loan', name: 'Préstamo socio', group: 'banks', source: 'Manual', balance: -15_000, syncedAt: NOW - 20 * HOURS },
];

const GROUP_LABEL: Record<Channel['group'], string> = {
  gateways: 'Pasarelas',
  exchanges: 'Exchanges',
  banks: 'Bancos',
};

function ago(ms: number): string {
  const mins = Math.floor((NOW - ms) / 60_000);
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}

function freshness(c: Channel): { kind: StatusKind; label: string } {
  if (c.balance == null) return { kind: 'pend', label: 'Sin dato' };
  if (c.stale) return { kind: 'stale', label: ago(c.syncedAt) };
  return { kind: 'ok', label: ago(c.syncedAt) };
}

const KPIS: KpiItem[] = [
  { key: 'avail', label: 'Disponible', value: 148_660.17, hero: true, sub: '1 canal sin dato', delta: { pct: 4.13, ref: '31 ago' } },
  { key: 'debt', label: 'Deuda', value: -15_000, format: 'money', sub: 'Préstamo socio' },
  { key: 'fair', label: 'FairPay', value: 12_904.1, staleAt: NOW - 26 * HOURS },
  { key: 'uni', label: 'UniPayment', value: null, sub: 'La API no respondió' },
  { key: 'exp', label: 'Egresos del mes', value: 38_400, delta: { pct: 12.5, ref: 'sep', goodWhen: 'down' } },
];

const MOVEMENTS = [
  { id: 'm1', concept: 'Retiro cliente #4821', who: 'Coinsbuy · USDT TRC20', amount: -2_400, status: 'paid' },
  { id: 'm2', concept: 'Depósito neto del día', who: 'Pay-Pros', amount: 8_120.4, status: 'pending' },
  { id: 'm3', concept: 'Comisión IB septiembre', who: 'Orden OP-0193', amount: -1_310.25, status: 'approved' },
  { id: 'm4', concept: 'Ajuste de conciliación', who: 'Manual', amount: 0.004, status: 'draft' },
  { id: 'm5', concept: 'Proveedor hosting', who: 'Orden OP-0188', amount: -320, status: 'rejected' },
];

function Gallery({ idPrefix }: { idPrefix: string }) {
  const [view, setView] = useState<'all' | 'in' | 'out'>('all');
  const [chips, setChips] = useState<Record<string, boolean>>({ api: true, manual: false, stale: false });
  const [selected, setSelected] = useState<string | null>('binance');
  const [amount, setAmount] = useState('12,5');

  const balanceColumns: FinColumn<Channel>[] = [
    {
      key: 'name',
      header: 'Canal',
      cell: (c) => c.name,
      meta: (c) => c.source,
      mobileMeta: (c) => {
        const f = freshness(c);
        return <StatusBadge kind={f.kind} label={f.label} />;
      },
    },
    {
      key: 'status',
      header: 'Actualizado',
      hideSm: true,
      cell: (c) => {
        const f = freshness(c);
        return <StatusBadge kind={f.kind} label={f.label} />;
      },
    },
    {
      key: 'balance',
      header: 'Saldo',
      kind: 'money',
      value: (c) => c.balance,
      money: { stale: (c) => (c.stale ? `Saldo de ${ago(c.syncedAt)}` : undefined) },
    },
  ];

  const known = CHANNELS.filter((c) => c.balance != null);
  const total = known.reduce((a, c) => a + (c.balance ?? 0), 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-[650] leading-7 tracking-[-0.015em] text-foreground">Primitivas «Libro mayor»</h1>
        <p className="text-[13.5px] text-text-2">Datos inventados. Sólo en desarrollo.</p>
      </header>

      <KpiStrip items={KPIS} now={NOW} />

      <div className="space-y-2">
        <Notice
          kind="stale"
          title="2 canales sin sincronizar"
          action={<a href={`#${idPrefix}-balances`} className="text-brand-ink underline">Revisar</a>}
        >
          FairPay (hace 26 h) y Kraken (hace 41 d) siguen sumando {formatMoney(13_844.6)} al disponible.
        </Notice>
        <Notice kind="pend" title="UniPayment sin dato" action={<a href={`#${idPrefix}-balances`} className="text-brand-ink underline">Revisar</a>}>
          Ese canal <strong>no está sumado</strong> en el disponible.
        </Notice>
        <Notice kind="info" title="Fuente automática">Los saldos con etiqueta API se refrescan cada 5 min.</Notice>
        <Notice kind="bad" title="No se pudo cerrar el período">El CRM no respondió al pedir el P&amp;L de septiembre.</Notice>
      </div>

      <div className="grid gap-4 min-[1100px]:grid-cols-2">
        <Panel title="Distribución del disponible" hint="Sobre activos líquidos; la deuda no entra" flush>
          <DistributionBar
            items={CHANNELS.map((c) => ({ key: c.id, label: c.name, value: c.balance, stale: c.stale }))}
          />
        </Panel>
        <Panel
          title="Estados"
          hint="statusKind() es el único mapa"
          footer="Montos: auto / sign / null / stale / compact"
        >
          <div className="flex flex-wrap gap-2">
            {STATUS_KINDS.map((k) => (
              <StatusBadge key={k} kind={k} label={k} />
            ))}
            <StatusBadge domain="paymentOrder" status="approved" label="Aprobada" />
            <StatusBadge domain="expense" status="parcial" label="Parcial" />
            <StatusBadge domain="fetch" status="stale" label="hace 26 h" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
            <Money value={1234.5} />
            <Money value={-1234.5} />
            <Money value={1234.5} signed tone="sign" />
            <Money value={-12} signed tone="sign" />
            <Money value={null} nullLabel="Sin dato" />
            <Money value={60_180.12} stale="Saldo de hace 26 h" />
            <Money value={45_205} compact />
            <Money value={-0.001} />
            <Money value={2500} currency="EUR" />
          </div>
        </Panel>
      </div>

      <Panel
        id={`${idPrefix}-balances`}
        title="Saldos por canal"
        hint="Agrupado, con subtotales; menos de 720 px pasa a tarjetas"
        flush
        actions={
          <>
            <Segmented
              aria-label="Vista"
              value={view}
              onChange={setView}
              options={[
                { value: 'all', label: 'Todos', count: CHANNELS.length },
                { value: 'in', label: 'Entradas' },
                { value: 'out', label: 'Salidas' },
              ]}
            />
            <button
              type="button"
              aria-label="Descargar"
              className="inline-flex size-8 items-center justify-center rounded-ui-md border border-border-strong bg-card text-text-2 hover:bg-surface-2 [@media(pointer:coarse)]:size-10"
            >
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
            </button>
          </>
        }
      >
        <FinTable
          caption="Saldos por canal"
          columns={balanceColumns}
          rows={CHANNELS}
          rowKey={(c) => c.id}
          groupBy={(c) => c.group}
          groupLabel={(g) => GROUP_LABEL[g as Channel['group']]}
          selectedKey={selected}
          onRowClick={(c) => setSelected(c.id)}
          rowActions={(c) => (
            <button
              type="button"
              aria-label={`Acciones de ${c.name}`}
              className="inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-2 [@media(pointer:coarse)]:size-10"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          )}
          footer={{
            label: `Total (${known.length} de ${CHANNELS.length} canales)`,
            values: { balance: total },
          }}
        />
      </Panel>

      <Panel title="Movimientos" hint="Recortada: el pie lo cuenta" flush>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {(['api', 'manual', 'stale'] as const).map((k) => (
            <Chip
              key={k}
              active={chips[k]}
              icon={Filter}
              count={k === 'api' ? 5 : null}
              onClick={() => setChips((s) => ({ ...s, [k]: !s[k] }))}
            >
              {k === 'api' ? 'API' : k === 'manual' ? 'Manual' : 'Desactualizados'}
            </Chip>
          ))}
        </div>
        <FinTable
          density="comfortable"
          columns={[
            { key: 'concept', header: 'Concepto', cell: (m) => m.concept, meta: (m) => m.who },
            {
              key: 'status',
              header: 'Estado',
              cell: (m) => <StatusBadge domain="paymentOrder" status={m.status} label={m.status} />,
              cardSide: 'right',
            },
            { key: 'amount', header: 'Monto', kind: 'money', value: (m) => m.amount, money: { signed: true, tone: 'sign' } },
          ]}
          rows={MOVEMENTS}
          rowKey={(m) => m.id}
          totalCount={1284}
          footer={{ label: 'Total del período (1.284 movimientos)', values: { amount: 52_310.77 } }}
        />
      </Panel>

      <Panel title="Formulario" hint="Alto 36, borde control-border, label siempre visible">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Concepto" hint="Como aparece en el extracto" required>
            <Input placeholder="Ej.: Retiro cliente" />
          </Field>
          <Field label="Monto" error={amount.includes(',') ? 'Usá punto decimal: 12.5' : undefined}>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Canal">
            <Select defaultValue="binance">
              {CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deshabilitado">
            <Input disabled value="No editable" readOnly />
          </Field>
          <Field label="Nota" className="sm:col-span-2">
            <Textarea placeholder="Opcional" />
          </Field>
        </div>
      </Panel>

      <Panel title="Vacío y sin cabecera de datos" flush>
        <FinTable columns={balanceColumns} rows={[]} rowKey={(c) => c.id} />
      </Panel>
    </div>
  );
}

export function DesignShowcase() {
  return (
    <div className="mx-auto max-w-[1360px] space-y-10">
      <section aria-label="Tema actual">
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-[.06em] text-text-3">
          Tema actual (cambialo con el botón de tema para ver claro)
        </p>
        <Gallery idPrefix="cur" />
      </section>
      <section
        aria-label="Oscuro"
        className={cn('dark rounded-ui-xl border border-border bg-background p-4 text-foreground sm:p-6')}
      >
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-[.06em] text-text-3">Oscuro (forzado con .dark)</p>
        <Gallery idPrefix="dark" />
      </section>
    </div>
  );
}
