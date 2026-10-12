import { describe, expect, it } from 'vitest';
import {
  bandKind,
  checkKind,
  decisionKind,
  depositStatusKind,
  factorKind,
  levelKind,
  marginKind,
  outcomeKind,
  withdrawalStatusKind,
} from './risk-kinds';
import { STATUS_DOMAINS, statusKind, type StatusKind } from '@/components/ui/status-kind';
import { STATUS_BADGE_CLASSES } from '@/components/ui/status-badge';
import type { RiskBand, FactorImpact } from '@/lib/withdrawal-risk/score';
import type { AccountRisk } from '@/lib/risk/account-review';

describe('bandKind — banda del score → color', () => {
  it('bajo = ok, medio = pend, alto = bad', () => {
    expect(bandKind('low')).toBe('ok');
    expect(bandKind('medium')).toBe('pend');
    expect(bandKind('high')).toBe('bad');
  });
  it('sin banda (nunca se revisó) es neutral, nunca ok', () => {
    expect(bandKind(null)).toBe('neutral');
    expect(bandKind(undefined)).toBe('neutral');
  });
});

describe('withdrawalStatusKind — status_norm de crm_withdrawals', () => {
  it('approved (= COMPLETED) es ok — el mapa viejo preguntaba por «completed» y lo dejaba gris', () => {
    expect(withdrawalStatusKind('approved')).toBe('ok');
    // `completed` NO existe en el CHECK de retiros (migración 088).
    expect(withdrawalStatusKind('completed')).toBe('neutral');
  });
  it('rejected = bad, pending = pend, cancelled = neutral', () => {
    expect(withdrawalStatusKind('rejected')).toBe('bad');
    expect(withdrawalStatusKind('pending')).toBe('pend');
    expect(withdrawalStatusKind('cancelled')).toBe('neutral');
  });
  it('un estado desconocido o null es neutral', () => {
    expect(withdrawalStatusKind('ON_FIRE')).toBe('neutral');
    expect(withdrawalStatusKind(null)).toBe('neutral');
    // Una clave heredada de Object.prototype no es un estado.
    expect(withdrawalStatusKind('toString')).toBe('neutral');
  });
});

describe('depositStatusKind — status_norm de crm_deposits', () => {
  it('completed = ok, in_review = info, pending = pend', () => {
    expect(depositStatusKind('completed')).toBe('ok');
    expect(depositStatusKind('in_review')).toBe('info');
    expect(depositStatusKind('pending')).toBe('pend');
    expect(depositStatusKind('cancelled')).toBe('neutral');
  });
});

describe('decisionKind / factorKind', () => {
  it('escalar requiere a finanzas (pend); aprobar ok; rechazar bad', () => {
    expect(decisionKind('escalate')).toBe('pend');
    expect(decisionKind('approve')).toBe('ok');
    expect(decisionKind('reject')).toBe('bad');
    expect(decisionKind(null)).toBe('neutral');
  });
  it('un factor que empuja a rechazar es bad', () => {
    expect(factorKind('down')).toBe('bad');
    expect(factorKind('up')).toBe('ok');
    expect(factorKind('neutral')).toBe('neutral');
  });
});

describe('checkKind — «sin comprobar» NO es cumplida', () => {
  it('unverifiable va en pend, nunca en ok', () => {
    expect(checkKind('unverifiable')).toBe('pend');
    expect(checkKind('pass')).toBe('ok');
    expect(checkKind('fail')).toBe('bad');
  });
});

describe('levelKind / outcomeKind / marginKind', () => {
  it('riesgo de cuenta y toxicidad', () => {
    expect(levelKind('alto')).toBe('bad');
    expect(levelKind('medio')).toBe('pend');
    expect(levelKind('ok')).toBe('ok');
    expect(levelKind(null)).toBe('neutral');
  });
  it('veredicto del reglamento de prop firm', () => {
    expect(outcomeKind('ok')).toBe('ok');
    expect(outcomeKind('denied_new_period')).toBe('pend');
    expect(outcomeKind('denied_no_new_period')).toBe('bad');
    expect(outcomeKind('cannot_review')).toBe('neutral');
    expect(outcomeKind(null)).toBe('neutral');
  });
  it('margen: la lista del server decide el color', () => {
    expect(marginKind('critical')).toBe('bad');
    expect(marginKind('watch')).toBe('pend');
  });
});

// ─── Mudanza a STATUS_DOMAINS (barrido final «Libro mayor», 2026-10-12) ────
// Los mapas se movieron de este módulo a components/ui/status-kind.ts. Esta
// tabla es la copia LITERAL de los mapas de antes de la mudanza: si alguien
// cambia un valor allá, falla acá y tiene que decidirlo a propósito.
const BEFORE_MOVE = {
  riskBand: { low: 'ok', medium: 'pend', high: 'bad' },
  withdrawalNorm: { approved: 'ok', rejected: 'bad', cancelled: 'neutral', pending: 'pend', unknown: 'neutral' },
  depositNorm: { completed: 'ok', cancelled: 'neutral', pending: 'pend', in_review: 'info', unknown: 'neutral' },
  reviewDecision: { approve: 'ok', reject: 'bad', escalate: 'pend', pending: 'neutral' },
  riskFactor: { down: 'bad', up: 'ok', neutral: 'neutral' },
  riskLevel: { ok: 'ok', medio: 'pend', alto: 'bad' },
  riskCheck: { pass: 'ok', fail: 'bad', unverifiable: 'pend' },
  propfirmOutcome: { ok: 'ok', denied_new_period: 'pend', denied_no_new_period: 'bad', cannot_review: 'neutral' },
} as const;
type MovedDomain = keyof typeof BEFORE_MOVE;

describe('mudanza de los mapas de Riesgo a STATUS_DOMAINS', () => {
  it('cada dominio es idéntico al mapa de antes (mismas claves, mismos kinds)', () => {
    for (const [domain, table] of Object.entries(BEFORE_MOVE)) {
      expect(STATUS_DOMAINS[domain as MovedDomain], domain).toEqual(table);
    }
  });

  it('el color resultante (clases del badge) no cambió para ningún estado', () => {
    const fns: Record<MovedDomain, (v: string) => StatusKind> = {
      riskBand: (v) => bandKind(v as RiskBand),
      withdrawalNorm: withdrawalStatusKind,
      depositNorm: depositStatusKind,
      reviewDecision: decisionKind,
      riskFactor: (v) => factorKind(v as FactorImpact),
      riskLevel: (v) => levelKind(v as AccountRisk),
      riskCheck: checkKind,
      propfirmOutcome: outcomeKind,
    };
    for (const [domain, table] of Object.entries(BEFORE_MOVE) as [MovedDomain, Record<string, StatusKind>][]) {
      for (const [status, kind] of Object.entries(table)) {
        const viaFn = fns[domain](status);
        expect(viaFn, `${domain}:${status}`).toBe(kind);
        expect(statusKind(domain, status), `${domain}:${status}`).toBe(kind);
        expect(STATUS_BADGE_CLASSES[viaFn]).toBe(STATUS_BADGE_CLASSES[kind]);
      }
    }
  });
});
