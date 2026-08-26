/**
 * Minimal RFC 4180 CSV parser. No dependencies.
 *
 * Handles quoted fields, embedded commas/newlines/quotes, CRLF, and a UTF-8 BOM.
 * Everything comes back as a string; type coercion is the caller's job.
 */

/**
 * @param {string} text raw CSV file contents
 * @returns {{headers: string[], rows: Record<string, string>[]}}
 */
export function parseCsv(text) {
  const table = parseCsvTable(text);
  if (table.length === 0) return { headers: [], rows: [] };

  const headers = table[0].map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    // Skip blank trailing lines (very common in exported files).
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = cells[c] === undefined ? '' : cells[c];
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Parse CSV into a raw array-of-arrays.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvTable(text) {
  if (typeof text !== 'string') return [];
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // strip BOM

  const table = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // has the current record produced any character?

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      table.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }

  if (started || field !== '' || row.length > 0) {
    row.push(field);
    table.push(row);
  }

  return table;
}

/**
 * Serialize rows back to CSV (used by the export endpoint).
 * @param {string[]} headers
 * @param {Array<Array<string|number|null|undefined>>} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const escape = (value) => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\n') + '\n';
}
