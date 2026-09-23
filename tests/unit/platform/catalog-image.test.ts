import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  catalogImageUrl,
  displayImageUrl,
  resolveCatalogImageRequest,
} from '@main/platform/catalog-image';

const roots = {
  coversCacheDir: resolve('/userData/cache/covers'),
  screenshotsCacheDir: resolve('/userData/cache/screenshots'),
};

describe('catalogImageUrl / displayImageUrl', () => {
  it('prefers the cached copy and falls back to the origin URL', () => {
    expect(displayImageUrl(join(roots.coversCacheDir, 'abc.jpg'), 'https://images.igdb.com/x.jpg', 'covers')).toBe(
      'catalog-image://covers/abc.jpg',
    );
    expect(displayImageUrl(null, 'https://images.igdb.com/x.jpg', 'covers')).toBe('https://images.igdb.com/x.jpg');
    expect(displayImageUrl(null, null, 'screenshots')).toBeNull();
  });

  it('encodes file names so spaces and unicode survive the round trip', () => {
    const url = catalogImageUrl('screenshots', 'Spi el ünique.jpg');
    expect(resolveCatalogImageRequest(url, roots)).toBe(join(roots.screenshotsCacheDir, 'Spi el ünique.jpg'));
  });
});

describe('resolveCatalogImageRequest', () => {
  it('maps each cache kind to its own directory', () => {
    expect(resolveCatalogImageRequest('catalog-image://covers/a.jpg', roots)).toBe(join(roots.coversCacheDir, 'a.jpg'));
    expect(resolveCatalogImageRequest('catalog-image://screenshots/b.png', roots)).toBe(
      join(roots.screenshotsCacheDir, 'b.png'),
    );
  });

  it('rejects the wrong scheme, unknown hosts and missing names', () => {
    expect(resolveCatalogImageRequest('file:///etc/passwd', roots)).toBeNull();
    expect(resolveCatalogImageRequest('catalog-image://elsewhere/a.jpg', roots)).toBeNull();
    expect(resolveCatalogImageRequest('catalog-image://covers/', roots)).toBeNull();
    expect(resolveCatalogImageRequest('not a url', roots)).toBeNull();
  });

  it('rejects traversal and separator smuggling', () => {
    for (const attempt of [
      'catalog-image://covers/..%2F..%2Fsettings.json',
      'catalog-image://covers/%2e%2e%2f%2e%2e%2fsettings.json',
      'catalog-image://covers/sub%2Ffile.jpg',
      'catalog-image://covers/sub%5Cfile.jpg',
      'catalog-image://covers/....//settings.json',
    ]) {
      expect(resolveCatalogImageRequest(attempt, roots)).toBeNull();
    }
  });
});
