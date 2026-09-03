// Índice de archivos del PDF de la orden de pago (Kevin 2026-09-03).
//
// Lo que se protege acá es la regla de la sección: con CERO archivos no hay
// filas —y por lo tanto el generador no pinta ni la barra ni la tabla—, con
// uno hay una, y con N hay N numeradas de 1 a N. Un "0 adjuntos" impreso, o
// una fila de más/de menos, es exactamente el fallo silencioso que el repo
// persigue: un documento plausible que no coincide con lo que respalda el pago.
//
// El pintado con jsPDF no se testea (necesita canvas/DOM): lo que decide qué
// se ve está acá, en puro.

import { describe, it, expect } from 'vitest';
import {
  buildFileIndexRows,
  fileTypeLabel,
  formatFileSize,
  type IndexableFile,
} from './file-index';

const opts = { unnamed: '(sin nombre)', formatDate: (v?: string | null) => v ?? '—' };

const file = (over: Partial<IndexableFile> = {}): IndexableFile => ({
  file_name: 'factura.pdf',
  mime: 'application/pdf',
  size: 2048,
  uploaded_at: '2026-09-01',
  ...over,
});

describe('buildFileIndexRows', () => {
  it('con CERO archivos no emite ninguna fila (la sección no se imprime)', () => {
    expect(buildFileIndexRows([], opts)).toEqual([]);
    expect(buildFileIndexRows(undefined, opts)).toEqual([]);
    expect(buildFileIndexRows(null, opts)).toEqual([]);
  });

  it('con UN archivo emite una fila numerada con los cinco campos', () => {
    const rows = buildFileIndexRows([file()], opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['1', 'factura.pdf', 'PDF', '2 KB', '2026-09-01']);
  });

  it('con N archivos emite N filas numeradas de 1 a N, en el orden recibido', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      file({ file_name: `doc-${i}.pdf` }),
    );
    const rows = buildFileIndexRows(files, opts);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r[0])).toEqual(['1','2','3','4','5','6','7','8','9','10']);
    expect(rows.map((r) => r[1])).toEqual(files.map((f) => f.file_name));
  });

  it('sin nombre guardado usa el texto del locale, no una celda vacía', () => {
    expect(buildFileIndexRows([file({ file_name: null })], opts)[0][1]).toBe('(sin nombre)');
    expect(buildFileIndexRows([file({ file_name: '   ' })], opts)[0][1]).toBe('(sin nombre)');
  });

  it('size null NO es 0: se muestra guion, no "0 B"', () => {
    expect(buildFileIndexRows([file({ size: null })], opts)[0][3]).toBe('—');
    expect(buildFileIndexRows([file({ size: 0 })], opts)[0][3]).toBe('0 B');
  });

  it('la fila legada (sin mime y sin fecha) igual sale listada', () => {
    // Es el adjunto que todavía vive en las columnas attachment_* de
    // payment_orders: loadOrderAttachments lo devuelve con uploaded_at ''.
    const rows = buildFileIndexRows(
      [{ file_name: 'contrato.docx', mime: null, size: null, uploaded_at: '' }],
      { ...opts, formatDate: (v) => (v ? v : '—') },
    );
    expect(rows).toEqual([['1', 'contrato.docx', 'DOCX', '—', '—']]);
  });
});

describe('fileTypeLabel', () => {
  it('manda el mime guardado por el servidor', () => {
    expect(fileTypeLabel({ file_name: 'x.txt', mime: 'application/pdf' })).toBe('PDF');
    expect(fileTypeLabel({
      file_name: 'x',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })).toBe('XLSX');
  });

  it('sin mime cae a la extensión del nombre', () => {
    expect(fileTypeLabel({ file_name: 'comprobante.PNG', mime: null })).toBe('PNG');
  });

  it('sin mime ni extensión no inventa un tipo', () => {
    expect(fileTypeLabel({ file_name: 'recibo', mime: null })).toBe('—');
    expect(fileTypeLabel({ file_name: null, mime: null })).toBe('—');
  });
});

describe('formatFileSize', () => {
  it('mantiene el formato que ya se ve en pantalla', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
