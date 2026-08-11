// Caracteres que, como PRIMER carácter de una celda, hacen que Excel / Google
// Sheets / LibreOffice interpreten el valor como una fórmula al abrir el CSV
// (=1+1, +cmd, -cmd, @cmd, y también TAB/CR que algunos parsers recortan antes
// de mirar el siguiente carácter). Prefijando una comilla simple, la celda se
// trata como texto literal y la fórmula no se ejecuta.
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (val: string | number) => {
    let str = String(val);
    // Guard de inyección de fórmulas. Solo aplica a valores STRING: un `number`
    // de JS (p.ej. un monto negativo -100) es un valor numérico genuino, no un
    // vector de inyección, y prefijarlo rompería el formato numérico en Excel.
    // Los campos de texto (concepto, categoría, nombre de usuario, etc.) son el
    // vector real y sí se neutralizan.
    if (typeof val === 'string' && str.length > 0 && FORMULA_TRIGGERS.has(str[0])) {
      str = `'${str}`;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csv = [
    headers.map(escape).join(','),
    ...rows.map(row => row.map(escape).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
