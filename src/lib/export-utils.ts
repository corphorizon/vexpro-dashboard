/**
 * Export utilities for PDF and Excel formats
 * Uses browser-native approaches without external dependencies
 */

// ─── Excel Export (XML Spreadsheet format) ───
export function downloadExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (val: string | number) => {
    const str = String(val);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const isNumber = (val: string | number) => typeof val === 'number' || (!isNaN(Number(val)) && val !== '');

  const headerCells = headers.map(h => `<Cell ss:StyleID="header"><Data ss:Type="String">${escape(h)}</Data></Cell>`).join('');
  const dataRows = rows.map(row => {
    const cells = row.map(cell => {
      if (isNumber(cell)) {
        return `<Cell><Data ss:Type="Number">${cell}</Data></Cell>`;
      }
      return `<Cell><Data ss:Type="String">${escape(cell)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default">
      <Font ss:FontName="Calibri" ss:Size="11"/>
    </Style>
    <Style ss:ID="header">
      <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
      <Interior ss:Color="#1E3A5F" ss:Pattern="Solid"/>
      <Font ss:Color="#FFFFFF" ss:Bold="1"/>
    </Style>
    <Style ss:ID="currency">
      <NumberFormat ss:Format="$#,##0.00"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Datos">
    <Table>
      <Row>${headerCells}</Row>
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xls') ? filename : `${filename}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── PDF Export (HTML-based print) ───
export function downloadPDF(
  title: string,
  headers: string[],
  rows: (string | number)[][],
  options?: {
    subtitle?: string;
    companyName?: string;
    date?: string;
    summary?: { label: string; value: string }[];
  }
) {
  const { subtitle, companyName, date, summary } = options || {};

  const escape = (val: string | number) => {
    const str = String(val);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const headerRow = headers.map(h => `<th style="background:#1E3A5F;color:#fff;padding:8px 12px;text-align:left;font-size:11px;border-bottom:2px solid #0d2137;">${escape(h)}</th>`).join('');

  const dataRows = rows.map((row, i) => {
    const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
    const cells = row.map((cell, j) => {
      const isNum = typeof cell === 'number' || (!isNaN(Number(cell)) && cell !== '');
      const align = isNum ? 'right' : 'left';
      const formatted = isNum ? `$${Number(cell).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : escape(cell);
      return `<td style="padding:6px 12px;text-align:${align};font-size:11px;border-bottom:1px solid #e2e8f0;">${formatted}</td>`;
    }).join('');
    return `<tr style="background:${bg}">${cells}</tr>`;
  }).join('');

  const summaryHTML = summary ? summary.map(s =>
    `<div style="display:inline-block;margin-right:24px;"><span style="color:#64748b;font-size:11px;">${escape(s.label)}:</span> <strong>${escape(s.value)}</strong></div>`
  ).join('') : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escape(title)}</title>
  <style>
    @page { margin: 1cm; size: landscape; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; color: #1e293b; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;border-bottom:2px solid #1E3A5F;padding-bottom:12px;">
    <div>
      ${companyName ? `<div style="font-size:18px;font-weight:bold;color:#1E3A5F;">${escape(companyName)}</div>` : ''}
      <div style="font-size:16px;font-weight:bold;">${escape(title)}</div>
      ${subtitle ? `<div style="font-size:12px;color:#64748b;">${escape(subtitle)}</div>` : ''}
    </div>
    <div style="text-align:right;">
      ${date ? `<div style="font-size:11px;color:#64748b;">${escape(date)}</div>` : ''}
      <div style="font-size:10px;color:#94a3b8;">Smart Dashboard</div>
    </div>
  </div>

  ${summaryHTML ? `<div style="margin-bottom:16px;padding:12px;background:#f1f5f9;border-radius:8px;">${summaryHTML}</div>` : ''}

  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;">
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>

  <div style="margin-top:20px;text-align:center;font-size:10px;color:#94a3b8;">
    Generado por Smart Dashboard &mdash; ${new Date().toLocaleString()}
  </div>

  <div class="no-print" style="margin-top:20px;text-align:center;">
    <button onclick="window.print();window.close();" style="padding:10px 24px;background:#1E3A5F;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;">
      Imprimir / Guardar PDF
    </button>
  </div>

  <script>window.onload=function(){window.print();}</script>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
}
