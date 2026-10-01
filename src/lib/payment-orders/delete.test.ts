// Eliminación definitiva de una orden de pago (pedido del dueño, 2026-10-01).
//
// El endpoint DELETE /api/admin/payment-orders/[id] no tiene harness de tests:
// lo que se fija acá es la lógica pura que decide QUÉ archivos se borran, cómo
// se cuenta lo que no se pudo borrar, qué confirmación ve el usuario y qué
// queda en el audit — que es lo único que sobrevive cuando ya no hay fila.

import { describe, it, expect } from 'vitest';
import {
  deleteAuditDetails,
  deleteConfirmKind,
  orderStoragePaths,
  splitStillReferenced,
  storageRemovalOutcome,
  type DeletedOrderSummary,
} from './delete';

describe('deleteConfirmKind', () => {
  it('una PAGADA pide el confirm fuerte (menciona el egreso)', () => {
    expect(deleteConfirmKind({ status: 'paid', expense_id: 'e1' })).toBe('paid');
    // Pagada SIN egreso (create_expense = false) igual: el servidor lo verifica.
    expect(deleteConfirmKind({ status: 'paid', expense_id: null })).toBe('paid');
  });

  it('borrador / anulada / aprobada / pendiente / rechazada → confirm simple', () => {
    for (const status of ['draft', 'cancelled', 'approved', 'pending', 'rejected'] as const) {
      expect(deleteConfirmKind({ status, expense_id: null })).toBe('simple');
    }
  });

  it('si por algún camino una no pagada tiene egreso apuntado, el aviso es el fuerte', () => {
    expect(deleteConfirmKind({ status: 'cancelled', expense_id: 'e9' })).toBe('paid');
  });
});

describe('orderStoragePaths', () => {
  it('junta filas + columna legada por bucket, sin duplicar el path del backfill', () => {
    const got = orderStoragePaths({
      proofPaths: ['c/o-1.pdf', 'c/o-2.png'],
      attachmentPaths: ['c/a-1.pdf'],
      // El backfill de 086/127 copió el legado a una fila: mismo path.
      legacyProofPath: 'c/o-1.pdf',
      legacyAttachmentPath: 'c/a-1.pdf',
    });
    expect(got).toEqual({ proofs: ['c/o-1.pdf', 'c/o-2.png'], attachments: ['c/a-1.pdf'] });
  });

  it('un legado que el backfill NO alcanzó se borra igual (si no, queda huérfano)', () => {
    const got = orderStoragePaths({
      proofPaths: [],
      attachmentPaths: [],
      legacyProofPath: 'c/viejo.pdf',
      legacyAttachmentPath: 'c/factura-vieja.pdf',
    });
    expect(got).toEqual({ proofs: ['c/viejo.pdf'], attachments: ['c/factura-vieja.pdf'] });
  });

  it('ignora null / vacíos', () => {
    expect(
      orderStoragePaths({ proofPaths: [null, '', '  '], attachmentPaths: [undefined], legacyProofPath: null }),
    ).toEqual({ proofs: [], attachments: [] });
  });
});

describe('splitStillReferenced', () => {
  it('preserva el comprobante que otro egreso todavía usa', () => {
    expect(splitStillReferenced(['a', 'b', 'c'], ['b', null])).toEqual({
      remove: ['a', 'c'],
      keep: ['b'],
    });
  });

  it('sin referencias externas, se borra todo', () => {
    expect(splitStillReferenced(['a'], [])).toEqual({ remove: ['a'], keep: [] });
  });
});

describe('storageRemovalOutcome', () => {
  it('lo pedido y no confirmado cuenta como fallido (Storage no da error por un path inexistente)', () => {
    expect(storageRemovalOutcome(3, 2)).toEqual({ removed: 2, failed: 1 });
  });

  it('si la llamada falló entera, TODO es fallido — nunca "0 fallidos" por omisión', () => {
    expect(storageRemovalOutcome(4, null)).toEqual({ removed: 0, failed: 4 });
  });

  it('nada pedido → nada que contar', () => {
    expect(storageRemovalOutcome(0, null)).toEqual({ removed: 0, failed: 0 });
  });

  it('no inventa borrados de más', () => {
    expect(storageRemovalOutcome(2, 5)).toEqual({ removed: 2, failed: 0 });
  });
});

describe('deleteAuditDetails', () => {
  const base: DeletedOrderSummary = {
    orden: {
      id: 'o1',
      order_number: 'OP-2026-0042',
      beneficiary_name: 'Proveedor SA',
      total: 1700,
      currency: 'USD',
      status: 'paid',
    },
    egresosBorrados: [{ id: 'exp-1', amount: 1700, concept: 'OP-2026-0042 · Proveedor SA', period_id: 'per-sep' }],
    adjuntosBorrados: { comprobantes: 2, respaldos: 1 },
    archivosBorrados: 3,
    archivosFallidos: 0,
    archivosPreservados: 0,
  };

  it('lleva número, beneficiario, total, estado y el egreso con id y monto', () => {
    const txt = deleteAuditDetails(base, 'Pagada');
    expect(txt).toContain('OP-2026-0042');
    expect(txt).toContain('Proveedor SA');
    expect(txt).toContain('USD 1700.00');
    expect(txt).toContain('estado al borrar: Pagada');
    expect(txt).toContain('egreso borrado: id exp-1, USD 1700.00');
    expect(txt).toContain('2 comprobante(s) y 1 respaldo(s)');
    expect(txt).toContain('3 borrado(s), 0 sin confirmar');
  });

  it('sin egreso lo dice explícitamente (no se omite la línea)', () => {
    const txt = deleteAuditDetails({ ...base, egresosBorrados: [] }, 'Borrador');
    expect(txt).toContain('egreso vinculado: no tenía');
  });

  it('informa fallidos y preservados', () => {
    const txt = deleteAuditDetails({ ...base, archivosFallidos: 1, archivosPreservados: 1 }, 'Pagada');
    expect(txt).toContain('1 sin confirmar');
    expect(txt).toContain('1 preservado(s)');
  });
});
