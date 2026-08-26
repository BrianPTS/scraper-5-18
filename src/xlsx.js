/**
 * Minimal .xlsx reader — enough to import a spreadsheet export, nothing more.
 *
 * An .xlsx is a ZIP of XML. This walks the ZIP central directory, inflates the
 * first worksheet (and the shared string table, when the file uses one), and
 * hands back the same `{headers, rows}` shape as the CSV parser, so everything
 * downstream is unchanged.
 *
 * Decompression uses the platform's own `DecompressionStream`, which Node 18+
 * and every current browser provide — so this file runs unmodified in the
 * server build and in the single-file browser build.
 *
 * Deliberately not supported: formulas (the cached value is used), styles, and
 * multiple sheets (the first is read). Dates stored as Excel serial numbers
 * come through as numbers; `parseTimestamp` converts them.
 */

const textDecoder = new TextDecoder();

/**
 * @param {ArrayBuffer|Uint8Array} input raw .xlsx bytes
 * @returns {Promise<{headers: string[], rows: Record<string, string>[]}>}
 */
export async function parseXlsx(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = readZipEntries(bytes);

  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  if (!sheetNames.length) {
    throw new Error('That .xlsx has no worksheets in it.');
  }

  const sheetXml = textDecoder.decode(await readEntry(bytes, entries.get(sheetNames[0])));
  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const shared = sharedEntry ? parseSharedStrings(textDecoder.decode(await readEntry(bytes, sharedEntry))) : [];

  return sheetToTable(sheetXml, shared);
}

/** True when these bytes start with a ZIP local file header ("PK\x03\x04"). */
export function looksLikeXlsx(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the End Of Central Directory record, scanning back from the tail.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('That file is not a readable .xlsx (no ZIP directory found).');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function readEntry(bytes, entry) {
  if (!entry) throw new Error('Expected part of the .xlsx is missing.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (view.getUint32(local, true) !== 0x04034b50) throw new Error('The .xlsx is corrupt.');

  // The local header repeats the name/extra lengths; the central directory's
  // copies can differ, so always trust the local ones for where data starts.
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const start = local + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return compressed; // stored
  if (entry.method !== 8) throw new Error(`Unsupported compression in the .xlsx (method ${entry.method}).`);

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Sheet XML
// ---------------------------------------------------------------------------

/** Strip a namespace prefix so `<x:row>` and `<row>` are handled alike. */
const TAG = (name) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*?(/>|>)`, 'g');

function parseSharedStrings(xml) {
  const out = [];
  const siBlocks = xml.split(/<(?:\w+:)?si\b[^>]*>/).slice(1);
  for (const block of siBlocks) {
    const end = block.search(/<\/(?:\w+:)?si>/);
    const body = end === -1 ? block : block.slice(0, end);
    // A shared string can be split across several <t> runs.
    const parts = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

function sheetToTable(xml, shared) {
  const rows = [];
  const rowChunks = xml.split(/<(?:\w+:)?row\b[^>]*>/).slice(1);

  for (const chunk of rowChunks) {
    const end = chunk.search(/<\/(?:\w+:)?row>/);
    const body = end === -1 ? chunk : chunk.slice(0, end);
    const cells = [];

    const cellRe = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let match;
    while ((match = cellRe.exec(body)) !== null) {
      const attrs = match[1] || '';
      const inner = match[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      const index = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 'inlineStr') {
        const parts = [...inner.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1]));
        value = parts.join('');
      } else {
        const v = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        value = v ? decodeXml(v[1]) : '';
        if (type === 's') value = shared[Number(value)] ?? '';
      }

      // Cells for empty columns are simply absent; pad so columns stay aligned.
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }

    rows.push(cells);
  }

  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => String(h ?? '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.length || cells.every((c) => String(c ?? '').trim() === '')) continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = cells[c] === undefined ? '' : String(cells[c]);
    out.push(row);
  }

  return { headers, rows: out };
}

/** "AB" → 27 (zero-based column index). */
function columnIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}
