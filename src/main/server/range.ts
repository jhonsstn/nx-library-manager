/**
 * Pure HTTP Range / disposition helpers used by the DBI HTTP server.
 *
 * Exact ports of `_parse_range` and `_content_disposition` from
 * `switch_catalog/http_server.py`; kept free of I/O so they can be unit tested
 * through focused range-request tests.
 */

import { quotePathComponent } from './directory-listing';

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a `Range` header into an inclusive byte range.
 *
 * Returns `null` when the range is absent, malformed, or unsatisfiable — the
 * caller answers `416` in that case. `size` is the total resource length.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | null {
  if (size < 1 || !header) return null;
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffixLength = Number(endText);
    if (suffixLength === 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  let end = endText ? Number(endText) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * `Content-Disposition` header for a download: an ASCII fallback name plus the
 * RFC 5987 UTF-8 form, so the original non-ASCII name survives.
 */
export function contentDisposition(fileName: string): string {
  let asciiName = '';
  for (const char of fileName) {
    asciiName += char.codePointAt(0)! > 0x7f ? '?' : char;
  }
  asciiName = asciiName.replace(/"/g, '');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${quotePathComponent(fileName)}`;
}
