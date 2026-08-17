// Tope de comprobantes por orden de pago (migración 086).
//
// La regla vive en types.ts, no en el endpoint, porque la aplican DOS lados: el
// POST de /proof (autoridad) y el diálogo de pago (que se adelanta para no
// subir 40 MB al pedo). Un "5" duplicado a mano en los dos archivos es la forma
// más segura de que un día el cliente permita 5 y el servidor 3, así que lo que
// se testea acá es justamente la función compartida.

import { describe, it, expect } from 'vitest';
import { MAX_PAYMENT_PROOFS, proofCountError } from './types';
import { hasAllowedProofExtension, sniffProof } from './proof-files';

describe('MAX_PAYMENT_PROOFS', () => {
  it('es el tope que pidió Kevin', () => {
    expect(MAX_PAYMENT_PROOFS).toBe(5);
  });
});

describe('proofCountError', () => {
  it('acepta el primer comprobante de una orden vacía', () => {
    expect(proofCountError(0, 1)).toBeNull();
  });

  it('acepta un lote que llega justo al tope', () => {
    expect(proofCountError(0, MAX_PAYMENT_PROOFS)).toBeNull();
    expect(proofCountError(4, 1)).toBeNull();
    expect(proofCountError(2, 3)).toBeNull();
  });

  it('rechaza cuando existentes + nuevos se pasan por uno', () => {
    const err = proofCountError(3, 3);
    expect(err).not.toBeNull();
    // El mensaje tiene que decir CUÁNTOS entran todavía, no solo "no se puede".
    expect(err).toMatch(/2 más/);
    expect(err).toMatch(String(MAX_PAYMENT_PROOFS));
  });

  it('con la orden llena avisa que hay que quitar alguno', () => {
    const err = proofCountError(MAX_PAYMENT_PROOFS, 1);
    expect(err).toMatch(/máximo/);
    expect(err).toMatch(/Quitá/);
  });

  it('un lote solo (sin existentes) que se pasa también se rechaza', () => {
    expect(proofCountError(0, MAX_PAYMENT_PROOFS + 1)).not.toBeNull();
  });

  it('sin archivos no es "entra": es un request vacío', () => {
    expect(proofCountError(0, 0)).toMatch(/No se recibió/);
    expect(proofCountError(2, 0)).toMatch(/No se recibió/);
  });

  it('singular/plural del conteo existente', () => {
    expect(proofCountError(1, MAX_PAYMENT_PROOFS)).toMatch(/1 comprobante:/);
    expect(proofCountError(2, MAX_PAYMENT_PROOFS)).toMatch(/2 comprobantes:/);
  });
});

// ── Validación del archivo ──────────────────────────────────────────────────
// El sniff es el ÚNICO control real: la extensión y el Content-Type los pone el
// cliente. Un .pdf que adentro es otra cosa tiene que ser rechazado.

const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);

describe('sniffProof', () => {
  it('reconoce los cuatro formatos por sus magic bytes', () => {
    expect(sniffProof(PDF)).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    expect(sniffProof(PNG)).toEqual({ ext: 'png', mime: 'image/png' });
    expect(sniffProof(JPG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffProof(WEBP)).toEqual({ ext: 'webp', mime: 'image/webp' });
  });

  it('rechaza un ejecutable aunque el nombre diga .pdf', () => {
    // "MZ" — cabecera de un .exe de Windows.
    expect(sniffProof(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
  });

  it('rechaza un ZIP/DOCX (no es comprobante)', () => {
    expect(sniffProof(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
  });

  it('rechaza un RIFF que no es WEBP (un .wav, por ejemplo)', () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(sniffProof(wav)).toBeNull();
  });

  it('no explota con archivos truncados', () => {
    expect(sniffProof(bytes())).toBeNull();
    expect(sniffProof(bytes(0x25, 0x50))).toBeNull();
    expect(sniffProof(bytes(0x89, 0x50, 0x4e))).toBeNull();
    // RIFF cortado antes de poder leer el "WEBP".
    expect(sniffProof(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0))).toBeNull();
  });
});

describe('hasAllowedProofExtension', () => {
  it('acepta la lista blanca sin importar mayúsculas', () => {
    for (const name of ['a.pdf', 'a.PNG', 'foto.JPG', 'x.jpeg', 'y.webp']) {
      expect(hasAllowedProofExtension(name)).toBe(true);
    }
  });

  it('rechaza lo demás, incluido un archivo sin extensión', () => {
    for (const name of ['a.exe', 'a.docx', 'comprobante', 'a.pdf.exe']) {
      expect(hasAllowedProofExtension(name)).toBe(false);
    }
  });
});
