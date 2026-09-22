/**
 * Pure HTML/text builders for the DBI HTTP server.
 *
 * Exact ports of `_send_directory_listing` / `_send_url_list` from
 * `switch_catalog/http_server.py`. File names are HTML-escaped for display and
 * percent-encoded for URLs, as two separate steps.
 */

import type { CatalogFileRecord } from './catalog-file-source';

/** `html.escape(value)` — the five characters the legacy listing escaped. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * `urllib.parse.quote` for UTF-8 text: letters, digits and `_.-~` stay as-is,
 * plus any character in `safe` (Python's default is `'/'`). Everything else is
 * percent-encoded byte by byte.
 */
export function quotePathComponent(value: string, safe = '/'): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9_.\-~]/.test(char) || safe.includes(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * `urllib.parse.unquote`: percent-decodes into bytes, then UTF-8 decodes with
 * U+FFFD replacement so malformed input degrades instead of throwing.
 */
export function unquotePathComponent(value: string): string {
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const char = String.fromCodePoint(value.codePointAt(index)!);
    if (char === '%' && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte);
    index += char.length;
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/** Apache-style `Index of /dir/` body with one link per catalog file. */
export function directoryListingHtml(records: CatalogFileRecord[]): string {
  const links = [...records]
    .sort((left, right) => {
      const a = left.fileName.toLowerCase();
      const b = right.fileName.toLowerCase();
      if (a === b) return 0;
      return a < b ? -1 : 1;
    })
    .map((record) => `<a href="${quotePathComponent(record.fileName)}">${escapeHtml(record.fileName)}</a>\n`)
    .join('');
  return `<html><head><title>Index of /dir/</title></head><body>\n<h1>Index of /dir/</h1>\n${links}</body></html>`;
}

/** DBI/Awoo URL list body: one `{baseUrl}/dl/{kind}/{id}/{name}` per record. */
export function urlListText(records: CatalogFileRecord[], baseUrl: string): string {
  const lines = records.map(
    (record) => `${baseUrl}/dl/${record.kind}/${record.id}/${quotePathComponent(record.fileName)}`,
  );
  return `${lines.join('\n')}\n`;
}
