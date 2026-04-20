'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Risk Management — Revisión Retiros Wallet Externa
//
// Auditing tool for external-wallet withdrawal requests. Today the data is
// fully mocked — when the CRM API integration ships, swap MOCK_REQUESTS for a
// fetch call. The verdict engine in `evaluateVerdict()` is API-agnostic so it
// will keep working as-is.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { cn } from '@/lib/utils';
import {
  Search,
  Filter,
  X,
  Wallet,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Shield,
  Eye,
  ArrowRightLeft,
  TrendingUp,
  TrendingDown,
  Clock,
  User as UserIcon,
  Mail,
  Globe,
  Calendar,
  Activity,
} from 'lucide-react';

// ─── Types ───

type WalletKind = 'Balance' | 'IB Program' | 'IB Social';
type KycStatus = 'Verificado' | 'Pendiente';
type VerdictLevel = 'APROBAR' | 'REVISAR' | 'RECHAZAR';

interface TradingAccount {
  number: string;
  platform: 'MT4' | 'MT5' | 'cTrader';
  balance: number;
  equity: number;
  pnl: number;
  openPositions: number;
  initialDeposit: number;
}

interface DepositRecord {
  date: string;
  amount: number;
  method: string;
  destinationWallet: WalletKind;
}

interface WithdrawalRecord {
  date: string;
  amount: number;
  status: 'Aprobado' | 'Rechazado' | 'Pendiente';
  fromWallet: WalletKind;
}

interface P2PRecord {
  date: string;
  direction: 'Enviado' | 'Recibido';
  counterparty: string;
  amount: number;
  wallet: WalletKind;
}

interface InternalMovement {
  date: string;
  type: 'Consolidación' | 'Distribución' | 'Ajuste';
  fromWallet: WalletKind;
  toWallet: WalletKind;
  amount: number;
}

interface WithdrawalRequest {
  id: string;
  user: {
    name: string;
    email: string;
    country: string;
    registeredAt: string;
  };
  kyc: KycStatus;
  amount: number;
  fromWallet: WalletKind;
  requestedAt: string;
  walletBalances: Record<WalletKind, number>;
  totalDeposited: number;
  totalWithdrawn: number;
  tradingAccounts: TradingAccount[];
  deposits: DepositRecord[];
  withdrawals: WithdrawalRecord[];
  p2p: P2PRecord[];
  internalMovements: InternalMovement[];
}

interface Verdict {
  level: VerdictLevel;
  reasons: string[];
}

// ─── Helpers ───

function fmt$(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24),
  );
}

function walletBadgeClass(w: WalletKind): string {
  switch (w) {
    case 'Balance':
      return 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900';
    case 'IB Program':
      return 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900';
    case 'IB Social':
      return 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900';
  }
}

function kycBadgeClass(k: KycStatus): string {
  return k === 'Verificado'
    ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
    : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900';
}

// ─── Verdict engine ───

function evaluateVerdict(req: WithdrawalRequest): Verdict {
  const reasons: string[] = [];
  let worstLevel: VerdictLevel = 'APROBAR';

  const escalate = (lvl: VerdictLevel) => {
    const order: Record<VerdictLevel, number> = { APROBAR: 0, REVISAR: 1, RECHAZAR: 2 };
    if (order[lvl] > order[worstLevel]) worstLevel = lvl;
  };

  // 1. KYC
  if (req.kyc !== 'Verificado') {
    reasons.push('KYC no verificado.');
    escalate('RECHAZAR');
  }

  // 2. Withdraw ratio (incluyendo este retiro)
  const projectedWithdrawn = req.totalWithdrawn + req.amount;
  const ratioPct = req.totalDeposited > 0
    ? (projectedWithdrawn / req.totalDeposited) * 100
    : Infinity;

  if (ratioPct > 100) {
    reasons.push(`Total retirado proyectado (${ratioPct.toFixed(1)}%) supera 100% de los depósitos.`);
    escalate('RECHAZAR');
  } else if (ratioPct >= 80) {
    reasons.push(`Total retirado proyectado (${ratioPct.toFixed(1)}%) está entre 80–100% de los depósitos.`);
    escalate('REVISAR');
  } else {
    reasons.push(`Ratio de retiro saludable (${ratioPct.toFixed(1)}% de los depósitos).`);
  }

  // 3. P2P sent in last 7 days
  const recentP2PSent = req.p2p.filter(
    (p) => p.direction === 'Enviado' && daysBetween(p.date, req.requestedAt) <= 7,
  );
  const recentP2PSentTotal = recentP2PSent.reduce((s, p) => s + p.amount, 0);
  const p2pPct = req.amount > 0 ? (recentP2PSentTotal / req.amount) * 100 : 0;

  if (recentP2PSentTotal > 0) {
    if (p2pPct > 50) {
      reasons.push(`P2P enviados últimos 7 días: ${fmt$(recentP2PSentTotal)} (${p2pPct.toFixed(1)}% del retiro) — patrón sospechoso.`);
      escalate('RECHAZAR');
    } else if (p2pPct > 30) {
      reasons.push(`P2P enviados últimos 7 días: ${fmt$(recentP2PSentTotal)} (${p2pPct.toFixed(1)}% del retiro).`);
      escalate('REVISAR');
    } else {
      reasons.push(`P2P enviados recientes menores: ${fmt$(recentP2PSentTotal)} (${p2pPct.toFixed(1)}% del retiro).`);
    }
  }

  // 4. Wallet consolidation in last 7 days
  const recentConsolidation = req.internalMovements.filter(
    (m) => m.type === 'Consolidación' && daysBetween(m.date, req.requestedAt) <= 7,
  );
  if (recentConsolidation.length > 0) {
    reasons.push(`Consolidación de wallets en los últimos 7 días (${recentConsolidation.length} movimiento(s)).`);
    escalate('RECHAZAR');
  }

  // 5. Open positions
  const accountsWithOpen = req.tradingAccounts.filter((a) => a.openPositions > 0);
  if (accountsWithOpen.length > 0) {
    const totalEquity = accountsWithOpen.reduce((s, a) => s + a.equity, 0);
    if (totalEquity <= 0) {
      reasons.push(`Posiciones abiertas con equity negativo en ${accountsWithOpen.length} cuenta(s).`);
      escalate('RECHAZAR');
    } else {
      reasons.push(`Posiciones abiertas en ${accountsWithOpen.length} cuenta(s) pero con equity positivo.`);
      escalate('REVISAR');
    }
  }

  // 6. Big trading losses
  const bigLossAccounts = req.tradingAccounts.filter(
    (a) => a.initialDeposit > 0 && a.pnl < 0 && Math.abs(a.pnl) > a.initialDeposit * 0.5,
  );
  if (bigLossAccounts.length > 0) {
    reasons.push(`${bigLossAccounts.length} cuenta(s) con pérdidas mayores al 50% del depósito inicial.`);
    escalate('RECHAZAR');
  }

  return { level: worstLevel, reasons };
}

// ─── Mock Data (5 scenarios) ───

const MOCK_REQUESTS: WithdrawalRequest[] = [
  // 1. Usuario limpio — APROBAR
  {
    id: 'wr-001',
    user: {
      name: 'Carlos Méndez',
      email: 'carlos.mendez@example.com',
      country: 'México',
      registeredAt: '2025-08-12T10:30:00Z',
    },
    kyc: 'Verificado',
    amount: 850,
    fromWallet: 'Balance',
    requestedAt: '2026-04-18T09:15:00Z',
    walletBalances: { Balance: 1250, 'IB Program': 320, 'IB Social': 0 },
    totalDeposited: 5000,
    totalWithdrawn: 1200,
    tradingAccounts: [
      { number: 'MT5-7723145', platform: 'MT5', balance: 4150, equity: 4150, pnl: 320, openPositions: 0, initialDeposit: 3000 },
    ],
    deposits: [
      { date: '2026-04-01T12:00:00Z', amount: 1500, method: 'Wire Transfer', destinationWallet: 'Balance' },
      { date: '2026-03-15T09:30:00Z', amount: 1500, method: 'USDT TRC20', destinationWallet: 'Balance' },
      { date: '2026-02-10T14:20:00Z', amount: 1000, method: 'Card', destinationWallet: 'Balance' },
      { date: '2026-01-05T16:45:00Z', amount: 1000, method: 'USDT TRC20', destinationWallet: 'Balance' },
    ],
    withdrawals: [
      { date: '2026-03-20T11:00:00Z', amount: 600, status: 'Aprobado', fromWallet: 'Balance' },
      { date: '2026-02-15T13:30:00Z', amount: 600, status: 'Aprobado', fromWallet: 'Balance' },
    ],
    p2p: [],
    internalMovements: [],
  },
  // 2. Usuario con P2P recientes — REVISAR
  {
    id: 'wr-002',
    user: {
      name: 'Ana Lucía Ramos',
      email: 'analucia.ramos@example.com',
      country: 'Colombia',
      registeredAt: '2025-11-22T14:10:00Z',
    },
    kyc: 'Verificado',
    amount: 2400,
    fromWallet: 'IB Program',
    requestedAt: '2026-04-18T11:20:00Z',
    walletBalances: { Balance: 380, 'IB Program': 2900, 'IB Social': 150 },
    totalDeposited: 8000,
    totalWithdrawn: 3200,
    tradingAccounts: [
      { number: 'MT5-7790832', platform: 'MT5', balance: 3200, equity: 3200, pnl: 480, openPositions: 0, initialDeposit: 2500 },
    ],
    deposits: [
      { date: '2026-04-02T10:00:00Z', amount: 2000, method: 'USDT TRC20', destinationWallet: 'Balance' },
      { date: '2026-03-10T08:00:00Z', amount: 3000, method: 'Wire Transfer', destinationWallet: 'IB Program' },
      { date: '2026-02-05T15:00:00Z', amount: 3000, method: 'USDT TRC20', destinationWallet: 'IB Program' },
    ],
    withdrawals: [
      { date: '2026-03-15T11:00:00Z', amount: 1600, status: 'Aprobado', fromWallet: 'IB Program' },
      { date: '2026-02-12T09:30:00Z', amount: 1600, status: 'Aprobado', fromWallet: 'IB Program' },
    ],
    p2p: [
      { date: '2026-04-15T13:00:00Z', direction: 'Enviado', counterparty: 'jose.silva@example.com', amount: 850, wallet: 'IB Program' },
      { date: '2026-04-13T10:30:00Z', direction: 'Recibido', counterparty: 'maria.lopez@example.com', amount: 200, wallet: 'Balance' },
    ],
    internalMovements: [],
  },
  // 3. Usuario sin KYC — RECHAZAR
  {
    id: 'wr-003',
    user: {
      name: 'Pablo Restrepo',
      email: 'pablo.restrepo@example.com',
      country: 'Argentina',
      registeredAt: '2026-04-01T18:00:00Z',
    },
    kyc: 'Pendiente',
    amount: 450,
    fromWallet: 'Balance',
    requestedAt: '2026-04-18T08:00:00Z',
    walletBalances: { Balance: 520, 'IB Program': 0, 'IB Social': 0 },
    totalDeposited: 500,
    totalWithdrawn: 0,
    tradingAccounts: [
      { number: 'MT5-7800211', platform: 'MT5', balance: 500, equity: 500, pnl: 0, openPositions: 0, initialDeposit: 500 },
    ],
    deposits: [
      { date: '2026-04-10T10:00:00Z', amount: 500, method: 'Card', destinationWallet: 'Balance' },
    ],
    withdrawals: [],
    p2p: [],
    internalMovements: [],
  },
  // 4. Usuario con consolidación de wallets — RECHAZAR/ESCALAR
  {
    id: 'wr-004',
    user: {
      name: 'Diego Sandoval',
      email: 'diego.sandoval@example.com',
      country: 'Chile',
      registeredAt: '2025-06-30T12:00:00Z',
    },
    kyc: 'Verificado',
    amount: 3800,
    fromWallet: 'Balance',
    requestedAt: '2026-04-18T10:45:00Z',
    walletBalances: { Balance: 4100, 'IB Program': 100, 'IB Social': 50 },
    totalDeposited: 12000,
    totalWithdrawn: 4500,
    tradingAccounts: [
      { number: 'MT5-7711088', platform: 'MT5', balance: 3500, equity: 3500, pnl: -200, openPositions: 0, initialDeposit: 3700 },
    ],
    deposits: [
      { date: '2026-03-22T10:00:00Z', amount: 4000, method: 'USDT TRC20', destinationWallet: 'IB Program' },
      { date: '2026-02-18T09:00:00Z', amount: 4000, method: 'Wire Transfer', destinationWallet: 'IB Social' },
      { date: '2026-01-12T15:00:00Z', amount: 4000, method: 'USDT TRC20', destinationWallet: 'Balance' },
    ],
    withdrawals: [
      { date: '2026-03-05T11:00:00Z', amount: 2500, status: 'Aprobado', fromWallet: 'Balance' },
      { date: '2026-02-01T13:00:00Z', amount: 2000, status: 'Aprobado', fromWallet: 'Balance' },
    ],
    p2p: [],
    internalMovements: [
      { date: '2026-04-16T09:00:00Z', type: 'Consolidación', fromWallet: 'IB Program', toWallet: 'Balance', amount: 2200 },
      { date: '2026-04-15T14:30:00Z', type: 'Consolidación', fromWallet: 'IB Social', toWallet: 'Balance', amount: 1800 },
    ],
  },
  // 5. Usuario con posiciones abiertas + retiro grande — REVISAR
  {
    id: 'wr-005',
    user: {
      name: 'Sofía Hernández',
      email: 'sofia.hernandez@example.com',
      country: 'Perú',
      registeredAt: '2025-09-18T11:30:00Z',
    },
    kyc: 'Verificado',
    amount: 5200,
    fromWallet: 'Balance',
    requestedAt: '2026-04-18T13:10:00Z',
    walletBalances: { Balance: 5800, 'IB Program': 420, 'IB Social': 90 },
    totalDeposited: 15000,
    totalWithdrawn: 6200,
    tradingAccounts: [
      { number: 'MT5-7755999', platform: 'MT5', balance: 4200, equity: 4750, pnl: 550, openPositions: 3, initialDeposit: 4000 },
      { number: 'MT4-7700112', platform: 'MT4', balance: 1800, equity: 1820, pnl: 60, openPositions: 1, initialDeposit: 1500 },
    ],
    deposits: [
      { date: '2026-04-05T10:00:00Z', amount: 3000, method: 'USDT TRC20', destinationWallet: 'Balance' },
      { date: '2026-03-15T08:00:00Z', amount: 4000, method: 'Wire Transfer', destinationWallet: 'Balance' },
      { date: '2026-02-12T14:00:00Z', amount: 4000, method: 'USDT TRC20', destinationWallet: 'Balance' },
      { date: '2026-01-20T16:00:00Z', amount: 4000, method: 'Card', destinationWallet: 'Balance' },
    ],
    withdrawals: [
      { date: '2026-03-25T11:00:00Z', amount: 3100, status: 'Aprobado', fromWallet: 'Balance' },
      { date: '2026-02-20T13:00:00Z', amount: 3100, status: 'Aprobado', fromWallet: 'Balance' },
    ],
    p2p: [],
    internalMovements: [],
  },
];

// ─── Verdict UI helpers ───

function VerdictBadge({ level, size = 'md' }: { level: VerdictLevel; size?: 'sm' | 'md' | 'lg' }) {
  const classes = {
    APROBAR: 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    REVISAR: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
    RECHAZAR: 'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
  };
  const Icon = level === 'APROBAR' ? CheckCircle : level === 'REVISAR' ? AlertTriangle : XCircle;
  const dot = level === 'APROBAR' ? '🟢' : level === 'REVISAR' ? '🟡' : '🔴';
  const sizeClass = size === 'lg' ? 'px-4 py-2 text-base' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border font-semibold', sizeClass, classes[level])}>
      <span>{dot}</span>
      <Icon className="w-4 h-4" />
      {level}
    </span>
  );
}

// ─── Page ───

export default function RetirosWalletPage() {
  const { user } = useAuth();
  const hasRiskAccess = useModuleAccess('risk');
  const router = useRouter();

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) {
      router.replace('/');
    }
  }, [user, hasRiskAccess, router]);

  const accessDenied = user !== null && !hasRiskAccess;

  // Filters
  const [search, setSearch] = useState('');
  const [walletFilter, setWalletFilter] = useState<'all' | WalletKind>('all');
  const [amountFilter, setAmountFilter] = useState<'all' | 'low' | 'mid' | 'high'>('all');

  // Selected request for audit panel
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filteredRequests = useMemo(() => {
    return MOCK_REQUESTS.filter((r) => {
      if (search && !`${r.user.name} ${r.user.email}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (walletFilter !== 'all' && r.fromWallet !== walletFilter) return false;
      if (amountFilter === 'low' && r.amount >= 500) return false;
      if (amountFilter === 'mid' && (r.amount < 500 || r.amount > 2000)) return false;
      if (amountFilter === 'high' && r.amount <= 2000) return false;
      return true;
    });
  }, [search, walletFilter, amountFilter]);

  const selected = useMemo(
    () => MOCK_REQUESTS.find((r) => r.id === selectedId) ?? null,
    [selectedId],
  );

  if (accessDenied) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="w-6 h-6 text-blue-600" />
            Revisión Retiros Wallet Externa
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Auditoría de solicitudes de retiro a wallets externas. Datos mock — pendiente integración CRM.
          </p>
        </div>
        <div className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          Modo mock — API CRM en proceso
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o email..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
            />
          </div>
          <select
            value={walletFilter}
            onChange={(e) => setWalletFilter(e.target.value as 'all' | WalletKind)}
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
          >
            <option value="all">Todas las wallets</option>
            <option value="Balance">Balance</option>
            <option value="IB Program">IB Program</option>
            <option value="IB Social">IB Social</option>
          </select>
          <select
            value={amountFilter}
            onChange={(e) => setAmountFilter(e.target.value as 'all' | 'low' | 'mid' | 'high')}
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
          >
            <option value="all">Cualquier monto</option>
            <option value="low">Menor a $500</option>
            <option value="mid">$500 — $2,000</option>
            <option value="high">Mayor a $2,000</option>
          </select>
        </div>
        <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
          <Filter className="w-3 h-3" />
          <span>{filteredRequests.length} solicitud(es) pendiente(s)</span>
        </div>
      </Card>

      {/* Table */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Usuario</th>
                <th className="text-right px-3 py-3 font-medium">Monto solicitado</th>
                <th className="text-left px-3 py-3 font-medium">Wallet origen</th>
                <th className="text-left px-3 py-3 font-medium">Fecha solicitud</th>
                <th className="text-left px-3 py-3 font-medium">KYC</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.map((r) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.user.name}</div>
                    <div className="text-xs text-muted-foreground">{r.user.email}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold">{fmt$(r.amount)}</td>
                  <td className="px-3 py-3">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', walletBadgeClass(r.fromWallet))}>
                      <Wallet className="w-3 h-3" />
                      {r.fromWallet}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground text-xs">{fmtDateTime(r.requestedAt)}</td>
                  <td className="px-3 py-3">
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', kycBadgeClass(r.kyc))}>
                      {r.kyc}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => setSelectedId(r.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-secondary)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Auditar
                    </button>
                  </td>
                </tr>
              ))}
              {filteredRequests.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    No hay solicitudes que coincidan con los filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Audit panel (slide-over) */}
      {selected && (
        <AuditPanel request={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

// ─── Audit Panel ───

function AuditPanel({ request, onClose }: { request: WithdrawalRequest; onClose: () => void }) {
  const verdict = useMemo(() => evaluateVerdict(request), [request]);

  const totalBalance = Object.values(request.walletBalances).reduce((s, n) => s + n, 0);
  const ratioRequest = totalBalance > 0 ? (request.amount / totalBalance) * 100 : 0;
  const depositVsWithdraw = request.totalDeposited > 0
    ? (request.totalWithdrawn / request.totalDeposited) * 100
    : 0;

  const recentP2PSent = request.p2p.filter(
    (p) => p.direction === 'Enviado' && daysBetween(p.date, request.requestedAt) <= 7,
  );
  const recentConsolidation = request.internalMovements.filter(
    (m) => m.type === 'Consolidación' && daysBetween(m.date, request.requestedAt) <= 7,
  );
  const accountsWithOpen = request.tradingAccounts.filter((a) => a.openPositions > 0);

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="ml-auto relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background border-b border-border px-6 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold">{request.user.name}</h2>
              <VerdictBadge level={verdict.level} />
            </div>
            <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{request.user.email}</span>
              <span className="inline-flex items-center gap-1"><Globe className="w-3 h-3" />{request.user.country}</span>
              <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />Reg. {fmtDate(request.user.registeredAt)}</span>
              <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', kycBadgeClass(request.kyc))}>
                KYC: {request.kyc}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <div className="text-2xl font-bold">{fmt$(request.amount)}</div>
              <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', walletBadgeClass(request.fromWallet))}>
                <Wallet className="w-3 h-3" />
                Origen: {request.fromWallet}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Section 1 — Resumen financiero */}
          <Section title="Resumen financiero" icon={Activity}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Depositado vs Retirado</div>
                <div className="flex items-center gap-2 text-sm font-medium mb-1">
                  <span>{fmt$(request.totalWithdrawn)} / {fmt$(request.totalDeposited)}</span>
                  <span className="text-xs text-muted-foreground">({depositVsWithdraw.toFixed(1)}%)</span>
                </div>
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      depositVsWithdraw < 80 ? 'bg-emerald-500'
                        : depositVsWithdraw <= 100 ? 'bg-amber-500'
                          : 'bg-rose-500',
                    )}
                    style={{ width: `${Math.min(100, depositVsWithdraw)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">Ratio retiro / saldo total</div>
                <div className="text-sm font-medium">
                  {fmt$(request.amount)} / {fmt$(totalBalance)}
                  <span className="text-xs text-muted-foreground ml-2">({ratioRequest.toFixed(1)}%)</span>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              {(['Balance', 'IB Program', 'IB Social'] as WalletKind[]).map((w) => (
                <div key={w} className="rounded-lg border border-border p-3">
                  <div className="text-xs text-muted-foreground mb-1">{w}</div>
                  <div className="text-base font-semibold">{fmt$(request.walletBalances[w])}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* Section 2 — Cuentas de trading */}
          <Section title={`Cuentas de trading (${request.tradingAccounts.length})`} icon={TrendingUp}>
            {accountsWithOpen.length > 0 && (
              <Alert
                kind="warning"
                msg={`Hay ${accountsWithOpen.length} cuenta(s) con posiciones abiertas al momento del retiro.`}
              />
            )}
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs min-w-[600px]">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-2 py-2 font-medium">Cuenta</th>
                    <th className="text-left px-2 py-2 font-medium">Plat.</th>
                    <th className="text-right px-2 py-2 font-medium">Balance</th>
                    <th className="text-right px-2 py-2 font-medium">Equity</th>
                    <th className="text-right px-2 py-2 font-medium">P&L</th>
                    <th className="text-center px-2 py-2 font-medium">Pos. abiertas</th>
                  </tr>
                </thead>
                <tbody>
                  {request.tradingAccounts.map((a) => (
                    <tr key={a.number} className="border-b border-border">
                      <td className="px-2 py-2 font-mono">{a.number}</td>
                      <td className="px-2 py-2">{a.platform}</td>
                      <td className="px-2 py-2 text-right">{fmt$(a.balance)}</td>
                      <td className="px-2 py-2 text-right">{fmt$(a.equity)}</td>
                      <td className={cn('px-2 py-2 text-right font-medium', a.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                        {a.pnl >= 0 ? '+' : ''}{fmt$(a.pnl)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {a.openPositions > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                            <AlertTriangle className="w-3 h-3" />
                            {a.openPositions}
                          </span>
                        ) : '0'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Section 3 — Historial de depósitos */}
          <Section title={`Últimos depósitos (${Math.min(10, request.deposits.length)})`} icon={TrendingUp}>
            <SimpleTable
              cols={['Fecha', 'Monto', 'Método', 'Wallet destino']}
              rows={request.deposits.slice(0, 10).map((d) => [
                fmtDate(d.date),
                fmt$(d.amount),
                d.method,
                <span key="w" className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', walletBadgeClass(d.destinationWallet))}>{d.destinationWallet}</span>,
              ])}
              emptyMsg="Sin depósitos registrados."
            />
          </Section>

          {/* Section 4 — Historial de retiros anteriores */}
          <Section title={`Retiros anteriores (${request.withdrawals.length})`} icon={TrendingDown}>
            <SimpleTable
              cols={['Fecha', 'Monto', 'Estado', 'Wallet origen']}
              rows={request.withdrawals.map((w) => [
                fmtDate(w.date),
                fmt$(w.amount),
                <span key="s" className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  w.status === 'Aprobado' ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900'
                    : w.status === 'Rechazado' ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900'
                      : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
                )}>{w.status}</span>,
                <span key="w" className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', walletBadgeClass(w.fromWallet))}>{w.fromWallet}</span>,
              ])}
              emptyMsg="Sin retiros previos."
            />
          </Section>

          {/* Section 5 — P2P */}
          <Section title={`Transferencias P2P (${request.p2p.length})`} icon={ArrowRightLeft}>
            {recentP2PSent.length > 0 && (
              <Alert
                kind={recentP2PSent.reduce((s, p) => s + p.amount, 0) > request.amount * 0.5 ? 'danger' : 'warning'}
                msg={`P2P enviados últimos 7 días: ${recentP2PSent.length} transacción(es) por ${fmt$(recentP2PSent.reduce((s, p) => s + p.amount, 0))}`}
              />
            )}
            <SimpleTable
              cols={['Fecha', 'Dirección', 'Contraparte', 'Monto', 'Wallet']}
              rows={request.p2p.map((p) => [
                fmtDate(p.date),
                <span key="d" className={cn(
                  'inline-flex items-center gap-1 text-xs font-medium',
                  p.direction === 'Enviado' ? 'text-rose-600' : 'text-emerald-600',
                )}>
                  {p.direction === 'Enviado' ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                  {p.direction}
                </span>,
                p.counterparty,
                fmt$(p.amount),
                <span key="w" className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', walletBadgeClass(p.wallet))}>{p.wallet}</span>,
              ])}
              emptyMsg="Sin transferencias P2P."
            />
          </Section>

          {/* Section 6 — Movimientos internos */}
          <Section title={`Movimientos internos (${request.internalMovements.length})`} icon={ArrowRightLeft}>
            {recentConsolidation.length > 0 && (
              <Alert
                kind="danger"
                msg={`Consolidación de wallets en últimos 7 días: ${recentConsolidation.length} movimiento(s).`}
              />
            )}
            <SimpleTable
              cols={['Fecha', 'Tipo', 'De → Hacia', 'Monto']}
              rows={request.internalMovements.map((m) => [
                fmtDate(m.date),
                <span key="t" className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  m.type === 'Consolidación' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
                    : 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
                )}>{m.type}</span>,
                <span key="f" className="inline-flex items-center gap-1.5 text-xs">
                  <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-medium', walletBadgeClass(m.fromWallet))}>{m.fromWallet}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-medium', walletBadgeClass(m.toWallet))}>{m.toWallet}</span>
                </span>,
                fmt$(m.amount),
              ])}
              emptyMsg="Sin movimientos internos."
            />
          </Section>

          {/* Section 7 — Veredicto automático */}
          <Section title="Veredicto automático" icon={Shield} highlight>
            <div className="flex items-center gap-3 mb-3">
              <VerdictBadge level={verdict.level} size="lg" />
            </div>
            <div className="space-y-1.5 mb-4">
              {verdict.reasons.map((r, i) => (
                <div key={i} className="text-sm flex items-start gap-2">
                  <span className="text-muted-foreground mt-0.5">•</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
              <button
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
                onClick={() => alert(`[mock] Aprobar retiro ${request.id}`)}
              >
                <CheckCircle className="w-4 h-4" />
                Aprobar retiro
              </button>
              <button
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors"
                onClick={() => alert(`[mock] Escalar a revisión profunda ${request.id}`)}
              >
                <AlertTriangle className="w-4 h-4" />
                Escalar a revisión profunda
              </button>
              <button
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 transition-colors"
                onClick={() => alert(`[mock] Rechazar retiro ${request.id}`)}
              >
                <XCircle className="w-4 h-4" />
                Rechazar
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Small reusable bits ───

function Section({
  title,
  icon: Icon,
  highlight,
  children,
}: {
  title: string;
  icon: typeof Wallet;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'rounded-xl border bg-card p-5',
      highlight ? 'border-[var(--color-secondary)] shadow-md' : 'border-border',
    )}>
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </div>
  );
}

function Alert({ kind, msg }: { kind: 'warning' | 'danger'; msg: string }) {
  const cls = kind === 'danger'
    ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300'
    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300';
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium mb-3', cls)}>
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      {msg}
    </div>
  );
}

function SimpleTable({
  cols,
  rows,
  emptyMsg,
}: {
  cols: string[];
  rows: React.ReactNode[][];
  emptyMsg: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">{emptyMsg}</div>
    );
  }
  return (
    <div className="overflow-x-auto -mx-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {cols.map((c, i) => (
              <th key={i} className="text-left px-2 py-2 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border">
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-2 align-middle">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
