// xlsx.js — a minimal, dependency-free Excel (.xlsx) writer for result exports: one sheet, a header row with a
// blue background and white bold text, a filter on every column, the header frozen, and column widths that fit.
// Numbers stay numbers and dates are real Excel dates, so people can sum, sort and filter by value. Pure apart from
// the Blob that zip.js returns, so it runs in Node tests.
import { createZip } from './zip.js';

export const HEADER_BLUE = '4472C4';     // Excel's own table blue; white bold text on it reads well
const MAX_CELL_TEXT = 32767;             // Excel's limit for one cell
const MAX_ROWS = 1048575;                // Excel's limit, less the header row
const DAY_MS = 86400000;
const EXCEL_EPOCH = 25569;               // 1970-01-01 as an Excel serial day

const xml = s => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A sheet name Excel accepts: no []:*?/\ , at most 31 characters, never empty. */
export function sheetName(name) {
  return String(name ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet1';
}

/** Epoch milliseconds -> an Excel serial date in this browser's time zone (as the tables show dates). */
export function excelDate(ms) {
  return (ms - new Date(ms).getTimezoneOffset() * 60000) / DAY_MS + EXCEL_EPOCH;
}

/**
 * A results table (the shape toCsv takes) as a sheet: number columns keep their raw numbers, date columns their
 * raw dates, everything else (and any value that isn't what its kind expects) the text the table shows.
 * @param columns  [{ name, label, kind? }]  kind 'number' | 'date' | 'text' (spatial.js fieldKind)
 * @param rows     [{ cells: { [name]: { text, raw } } }]
 * @returns { name, columns: [{ label, kind }], rows: [[number | string | null]] }
 */
export function sheetFromTable(name, columns, rows) {
  const value = (c, cell) => {
    const raw = cell?.raw;
    if (c.kind === 'number' && typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (c.kind === 'date' && (typeof raw === 'number' || raw instanceof Date) && Number.isFinite(+raw)) return +raw;
    const text = cell?.text;
    return text == null || text === '—' || text === '' ? null : String(text);
  };
  return {
    name,
    columns: columns.map(c => ({ label: c.label ?? c.name, kind: c.kind === 'number' || c.kind === 'date' ? c.kind : 'text' })),
    rows: rows.map(r => columns.map(c => value(c, r.cells?.[c.name])))
  };
}

// Styles: 0 normal, 1 the blue header, 2 a date and time.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${HEADER_BLUE}"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * The parts of the .xlsx package (pure: strings only).
 * @param sheet  { name, columns: [{ label, kind }], rows: [[value]] } (sheetFromTable); a date value is epoch ms
 * @returns [{ path, content }]
 */
export function xlsxFiles(sheet) {
  const cols = sheet.columns ?? [];
  const rows = (sheet.rows ?? []).slice(0, MAX_ROWS);
  const name = sheetName(sheet.name);
  const last = columnLetter(Math.max(0, cols.length - 1));
  const range = `A1:${last}${rows.length + 1}`;

  const text = (ref, s, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(String(s).slice(0, MAX_CELL_TEXT))}</t></is></c>`;
  const cell = (ref, v, kind) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return kind === 'date' ? `<c r="${ref}" s="2"><v>${excelDate(v)}</v></c>` : `<c r="${ref}"><v>${v}</v></c>`;
    return text(ref, v);
  };
  const letters = cols.map((_, i) => columnLetter(i));
  const sheetRows = [`<row r="1">${cols.map((c, i) => text(`${letters[i]}1`, c.label ?? '', 1)).join('')}</row>`];
  rows.forEach((r, ri) => {
    const n = ri + 2;
    sheetRows.push(`<row r="${n}">${cols.map((c, i) => cell(`${letters[i]}${n}`, r[i], c.kind)).join('')}</row>`);
  });

  // Widths from the header and the first rows' text; +3 leaves room for the filter button.
  const sample = rows.slice(0, 500);
  const widths = cols.map((c, i) => {
    let w = String(c.label ?? '').length + 3;
    for (const r of sample) {
      const v = r[i];
      const len = v == null ? 0 : c.kind === 'date' && typeof v === 'number' ? 16 : String(v).length;
      if (len + 1 > w) w = len + 1;
    }
    return Math.min(60, Math.max(8, w));
  });

  const ws = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${range}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''}
<sheetData>${sheetRows.join('')}</sheetData>
${cols.length ? `<autoFilter ref="${range}"/>` : ''}
</worksheet>`;

  const quoted = `'${name.replace(/'/g, "''")}'`;
  const filterRange = `${quoted}!$A$1:$${last}$${rows.length + 1}`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets>
${cols.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xml(filterRange)}</definedName></definedNames>` : ''}
</workbook>`;

  return [
    { path: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { path: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { path: 'xl/workbook.xml', content: workbook },
    { path: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { path: 'xl/worksheets/sheet1.xml', content: ws },
    { path: 'xl/styles.xml', content: STYLES }
  ];
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The workbook as a Blob, ready to download. */
export function toXlsx(sheet) {
  const zip = createZip(xlsxFiles(sheet));
  return new Blob([zip], { type: XLSX_TYPE });
}
