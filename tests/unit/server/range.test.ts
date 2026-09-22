import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/legacy/behavior.json';
import { contentDisposition, parseByteRange } from '../../../src/main/server/range';

describe('parseByteRange', () => {
  it('reproduces every range case captured from the Qt build', () => {
    for (const { header, size, expected } of fixture.httpRange) {
      expect(parseByteRange(header, size), `${header} (size ${size})`).toEqual(
        expected === null ? null : { start: expected[0], end: expected[1] },
      );
    }
  });

  it('treats missing or blank headers as no range', () => {
    expect(parseByteRange(null, 1000)).toBeNull();
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('', 1000)).toBeNull();
    expect(parseByteRange('   ', 1000)).toBeNull();
  });

  it('ignores surrounding whitespace and clamps oversized suffix ranges', () => {
    expect(parseByteRange('  bytes=2-5  ', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('bytes=-4096', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=1-2-3', 1000)).toBeNull();
    expect(parseByteRange('bytes=1 -2', 1000)).toBeNull();
    expect(parseByteRange('bytes=1', 1000)).toBeNull();
    expect(parseByteRange('bytes= -5', 1000)).toBeNull();
    expect(parseByteRange('bytes=5-', 5)).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('matches the values captured from the Qt build', () => {
    for (const [fileName, expected] of Object.entries(fixture.httpContentDisposition)) {
      expect(contentDisposition(fileName), fileName).toBe(expected);
    }
  });

  it('keeps the original name recoverable from the RFC 5987 value', () => {
    const name = 'Spiel Übersicht.nsp';
    const value = contentDisposition(name);
    const encoded = value.slice(value.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
    expect(decodeURIComponent(encoded)).toBe(name);
  });
});
