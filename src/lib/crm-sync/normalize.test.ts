import { describe, expect, it } from 'vitest';
import {
  ABSURD_DEPOSIT_VALUE,
  docWatermark,
  isAbsurdDepositValue,
  normalizeDepositStatus,
  normalizeWithdrawalStatus,
  sanitizeDepositValue,
  toDepositRow,
  toIso,
  toNum,
  toRaw,
  toStr,
  toUserRow,
  toWithdrawalRow,
} from './normalize';

const COMPANY = '00000000-0000-0000-0000-000000000001';
const SYNCED = '2026-08-24T00:20:00.000Z';

describe('normalizeWithdrawalStatus', () => {
  // Los 7 estados que realmente existen en prod (13.524 retiros medidos).
  it.each([
    ['COMPLETED', 'approved'],
    ['REJECTED', 'rejected'],
    ['CANCELLED', 'cancelled'],
    ['CANCELED', 'cancelled'], // typo del CRM: 6 casos reales, misma semántica
    ['ON_HOLD', 'pending'],
    ['REQUESTED', 'pending'],
    ['IN_PROCESS', 'pending'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeWithdrawalStatus(raw)).toBe(expected);
  });

  it('canoniza mayúsculas, espacios y guiones antes de mapear', () => {
    expect(normalizeWithdrawalStatus('in process')).toBe('pending');
    expect(normalizeWithdrawalStatus('on-hold')).toBe('pending');
    expect(normalizeWithdrawalStatus('  completed  ')).toBe('approved');
  });

  it('un estado nuevo del CRM cae en unknown, no se traga como pending', () => {
    expect(normalizeWithdrawalStatus('FROZEN')).toBe('unknown');
    expect(normalizeWithdrawalStatus('')).toBe('unknown');
    expect(normalizeWithdrawalStatus(null)).toBe('unknown');
    expect(normalizeWithdrawalStatus(undefined)).toBe('unknown');
    expect(normalizeWithdrawalStatus(42)).toBe('unknown');
  });
});

describe('normalizeDepositStatus', () => {
  // Los 4 estados reales (39.413 depósitos medidos).
  it.each([
    ['COMPLETED', 'completed'],
    ['CANCELLED', 'cancelled'],
    ['REQUESTED', 'pending'],
    ['IN_REVIEW', 'in_review'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeDepositStatus(raw)).toBe(expected);
  });

  it('cubre el typo CANCELED por si aparece también en depósitos', () => {
    expect(normalizeDepositStatus('CANCELED')).toBe('cancelled');
  });

  it('desconocido → unknown', () => {
    expect(normalizeDepositStatus('CHARGEBACK')).toBe('unknown');
    expect(normalizeDepositStatus(null)).toBe('unknown');
  });
});

describe('toIso', () => {
  it('acepta Date, string ISO, epoch y {$date}', () => {
    expect(toIso(new Date('2026-08-24T10:00:00Z'))).toBe('2026-08-24T10:00:00.000Z');
    expect(toIso('2026-08-24T10:00:00Z')).toBe('2026-08-24T10:00:00.000Z');
    expect(toIso(1_756_029_600_000)).toBe(new Date(1_756_029_600_000).toISOString());
    expect(toIso({ $date: '2026-08-24T10:00:00Z' })).toBe('2026-08-24T10:00:00.000Z');
  });

  it('fecha inválida → null (nunca 1970 fantasma)', () => {
    expect(toIso(new Date('nope'))).toBeNull();
    expect(toIso('no soy una fecha')).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso(NaN)).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso({})).toBeNull();
  });
});

describe('toNum', () => {
  it('lee números y strings numéricos', () => {
    expect(toNum(125.5)).toBe(125.5);
    expect(toNum('125.50')).toBe(125.5);
    expect(toNum(0)).toBe(0);
    expect(toNum({ $numberDecimal: '99.9' })).toBe(99.9);
  });

  it('lo que no es un número finito es null', () => {
    expect(toNum(NaN)).toBeNull();
    expect(toNum(Infinity)).toBeNull();
    expect(toNum('abc')).toBeNull();
    expect(toNum('')).toBeNull();
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    // Un booleano NO es 1/0: sería tragar un error de esquema.
    expect(toNum(true)).toBeNull();
    expect(toNum({})).toBeNull();
  });
});

describe('toStr', () => {
  it('normaliza vacíos a null', () => {
    expect(toStr('  hola  ')).toBe('hola');
    expect(toStr('')).toBeNull();
    expect(toStr('   ')).toBeNull();
    expect(toStr(null)).toBeNull();
    expect(toStr(undefined)).toBeNull();
    expect(toStr(7)).toBe('7');
  });

  it('un ObjectId (con _bsontype) se lee por su toString', () => {
    const oid = { _bsontype: 'ObjectID', toString: () => '64f0c0ffee' };
    expect(toStr(oid)).toBe('64f0c0ffee');
  });
});

describe('depositValue corrupto (trampa 1)', () => {
  it('un valor absurdo se guarda como null', () => {
    expect(sanitizeDepositValue(1.4e16)).toBeNull();
    expect(sanitizeDepositValue(ABSURD_DEPOSIT_VALUE)).toBeNull();
    expect(sanitizeDepositValue(-5.7e16)).toBeNull();
  });

  it('un valor plausible se conserva', () => {
    expect(sanitizeDepositValue(250)).toBe(250);
    expect(sanitizeDepositValue('1000.25')).toBe(1000.25);
    expect(sanitizeDepositValue(ABSURD_DEPOSIT_VALUE - 1)).toBe(ABSURD_DEPOSIT_VALUE - 1);
  });

  it('isAbsurdDepositValue sólo marca números legibles y absurdos', () => {
    expect(isAbsurdDepositValue(1.4e16)).toBe(true);
    expect(isAbsurdDepositValue(250)).toBe(false);
    expect(isAbsurdDepositValue('basura')).toBe(false);
    expect(isAbsurdDepositValue(null)).toBe(false);
  });
});

describe('toRaw', () => {
  it('serializa Date/ObjectId y descarta las claves pedidas', () => {
    const raw = toRaw(
      {
        _id: { _bsontype: 'ObjectID', toString: () => 'abc123' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        __v: 0,
        nested: { n: NaN, ok: 1, arr: [1, 'dos'] },
      },
      ['__v'],
    );
    expect(raw._id).toBe('abc123');
    expect(raw.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(raw).not.toHaveProperty('__v');
    // NaN no existe en jsonb: se guarda null en vez de romper el INSERT.
    expect(raw.nested).toEqual({ n: null, ok: 1, arr: [1, 'dos'] });
  });
});

describe('toWithdrawalRow', () => {
  const doc = {
    _id: { _bsontype: 'ObjectID', toString: () => 'oid-1' },
    withdrawId: 'W-1001',
    userId: 'U-77',
    username: 'juanp',
    email: 'juan@example.com',
    requestedAmount: 500,
    transactionAmount: 490,
    fee: 10,
    coin: 'USDT',
    network: 'TRON',
    processor: 'COINSBUY',
    status: 'COMPLETED',
    type: 'CRYPTO',
    requestedDate: new Date('2026-08-01T12:00:00Z'),
    authorizedDate: new Date('2026-08-01T14:00:00Z'),
    processedDate: new Date('2026-08-02T09:00:00Z'),
    targetAddress: 'TXyz…',
    totalDepositLifetime: 3000,
    totalWithdrawLifetime: 1200,
    walletType: 'BALANCE',
    updatedAt: new Date('2026-08-02T09:00:01Z'),
  };

  it('mapea el documento completo', () => {
    const row = toWithdrawalRow(doc, COMPANY, SYNCED)!;
    expect(row.company_id).toBe(COMPANY);
    expect(row.external_id).toBe('W-1001');
    expect(row.user_external_id).toBe('U-77');
    expect(row.status_raw).toBe('COMPLETED');
    expect(row.status_norm).toBe('approved');
    expect(row.requested_at).toBe('2026-08-01T12:00:00.000Z');
    expect(row.processed_at).toBe('2026-08-02T09:00:00.000Z');
    expect(row.processor).toBe('COINSBUY');
    // Trampa 2: se copian pero quedan marcados como no confiables.
    expect(row.crm_total_deposit_lifetime).toBe(3000);
    expect(row.crm_total_withdraw_lifetime).toBe(1200);
    expect(row.synced_at).toBe(SYNCED);
    expect(row.raw.walletType).toBe('BALANCE');
  });

  it('sin withdrawId cae a _id', () => {
    const { withdrawId: _omit, ...sinId } = doc;
    void _omit;
    expect(toWithdrawalRow(sinId, COMPANY, SYNCED)!.external_id).toBe('oid-1');
  });

  it('sin ninguna llave devuelve null (rompería el UNIQUE)', () => {
    expect(toWithdrawalRow({ status: 'COMPLETED' }, COMPANY, SYNCED)).toBeNull();
  });

  it('doc mínimo: todo lo opcional queda en null y el estado en unknown', () => {
    const row = toWithdrawalRow({ withdrawId: 'W-2' }, COMPANY, SYNCED)!;
    expect(row.external_id).toBe('W-2');
    expect(row.status_norm).toBe('unknown');
    expect(row.status_raw).toBeNull();
    expect(row.requested_amount).toBeNull();
    expect(row.requested_at).toBeNull();
    expect(row.target_address).toBeNull();
    expect(row.crm_total_deposit_lifetime).toBeNull();
  });

  it('fechas inválidas → null', () => {
    const row = toWithdrawalRow(
      { withdrawId: 'W-3', requestedDate: 'ayer', processedDate: new Date('x') },
      COMPANY,
      SYNCED,
    )!;
    expect(row.requested_at).toBeNull();
    expect(row.processed_at).toBeNull();
  });
});

describe('toDepositRow', () => {
  it('amount_paid es el dinero y deposit_value corrupto se anula (trampa 1)', () => {
    const row = toDepositRow(
      {
        depositId: 'D-500',
        userId: 'U-77',
        depositValue: 1.4e16,
        amountPaid: 250.75,
        depositStatus: 'COMPLETED',
        depositType: 'CRYPTO',
        depositDate: new Date('2026-08-10T10:00:00Z'),
        externalPaymentId: 'cb-9911',
        isFIATPayment: false,
        coin: 'USDT',
        network: 'BSC',
        walletType: 'BALANCE',
      },
      COMPANY,
      SYNCED,
    )!;
    expect(row.amount_paid).toBe(250.75);
    expect(row.deposit_value).toBeNull();
    expect(row.status_norm).toBe('completed');
    expect(row.external_payment_id).toBe('cb-9911');
    expect(row.is_fiat).toBe(false);
    // Trampa 3: walletType NO se convierte en processor (la tabla ni lo tiene).
    expect(row).not.toHaveProperty('processor');
    expect(row.raw.walletType).toBe('BALANCE');
  });

  it('deposit_value plausible se conserva', () => {
    const row = toDepositRow(
      { depositId: 'D-1', depositValue: 300, amountPaid: 295, depositStatus: 'REQUESTED' },
      COMPANY,
      SYNCED,
    )!;
    expect(row.deposit_value).toBe(300);
    expect(row.status_norm).toBe('pending');
  });

  it('doc mínimo y sin llave', () => {
    const row = toDepositRow({ depositId: 'D-2' }, COMPANY, SYNCED)!;
    expect(row.status_norm).toBe('unknown');
    expect(row.amount_paid).toBeNull();
    expect(row.deposit_at).toBeNull();
    expect(row.is_fiat).toBeNull();
    expect(toDepositRow({ amountPaid: 10 }, COMPANY, SYNCED)).toBeNull();
  });
});

describe('toUserRow', () => {
  it('mapea el perfil y aplana pendingFeeDebt', () => {
    const row = toUserRow(
      {
        userId: 'U-77',
        clientId: 'C-9',
        username: 'juanp',
        email: 'juan@example.com',
        country: 'Argentina',
        countryCode: '+54',
        countryISOCode: 'AR',
        status: 'ACTIVE',
        kycStatus: 'APPROVED',
        userType: 'CLIENT',
        registerDate: new Date('2025-03-01T00:00:00Z'),
        sponsorUsername: 'mariaf',
        rank: 3,
        pendingFeeDebt: { amount: 12.5, concept: 'inactividad' },
        hierarchy: ['a', 'b', 'c'],
      },
      COMPANY,
      SYNCED,
    )!;
    expect(row.user_external_id).toBe('U-77');
    expect(row.country).toBe('Argentina');
    expect(row.rank).toBe('3');
    expect(row.pending_fee_debt).toBe(12.5);
    expect(row.register_date).toBe('2025-03-01T00:00:00.000Z');
    // hierarchy se descarta del raw: crece sin techo y nadie la usa.
    expect(row.raw).not.toHaveProperty('hierarchy');
  });

  it('sin country usa el ISO; sin registerDate usa createdAt', () => {
    const row = toUserRow(
      {
        userId: 'U-1',
        countryISOCode: 'MX',
        countryCode: '+52',
        createdAt: new Date('2024-01-02T00:00:00Z'),
      },
      COMPANY,
      SYNCED,
    )!;
    // countryCode es el prefijo telefónico: NO puede terminar en `country`.
    expect(row.country).toBe('MX');
    expect(row.register_date).toBe('2024-01-02T00:00:00.000Z');
  });

  it('doc mínimo y sin identificador', () => {
    const row = toUserRow({ clientId: 'C-1' }, COMPANY, SYNCED)!;
    expect(row.user_external_id).toBe('C-1');
    expect(row.email).toBeNull();
    expect(row.pending_fee_debt).toBeNull();
    expect(toUserRow({ username: 'x' }, COMPANY, SYNCED)).toBeNull();
  });
});

describe('docWatermark', () => {
  it('prefiere updatedAt y cae a createdAt', () => {
    expect(
      docWatermark({
        updatedAt: new Date('2026-08-02T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBe('2026-08-02T00:00:00.000Z');
    expect(docWatermark({ createdAt: new Date('2026-01-01T00:00:00Z') })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(docWatermark({})).toBeNull();
  });
});
