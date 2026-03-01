// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BUNDLED_FONTS, DEFAULT_FONT_FAMILY, resolveFont } from './fonts';

describe('BUNDLED_FONTS', () => {
  it('has 8 fonts', () => {
    expect(BUNDLED_FONTS).toHaveLength(8);
  });

  it('all fonts have required fields', () => {
    for (const font of BUNDLED_FONTS) {
      expect(font.id).toBeTruthy();
      expect(font.name).toBeTruthy();
      expect(font.family).toBeTruthy();
      expect(font.regular).toMatch(/\.woff2$/);
      expect(font.bold).toMatch(/\.woff2$/);
    }
  });

  it('all font IDs are unique', () => {
    const ids = BUNDLED_FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('can look up a known font by ID', () => {
    const font = BUNDLED_FONTS.find((f) => f.id === 'jetbrainsmono-nf');
    expect(font).toBeDefined();
    expect(font!.family).toBe('JetBrainsMono NF');
  });
});

describe('DEFAULT_FONT_FAMILY', () => {
  it('ends with monospace', () => {
    expect(DEFAULT_FONT_FAMILY).toMatch(/monospace$/);
  });

  it('contains common monospace fonts', () => {
    expect(DEFAULT_FONT_FAMILY).toContain('JetBrains Mono');
    expect(DEFAULT_FONT_FAMILY).toContain('Consolas');
    expect(DEFAULT_FONT_FAMILY).toContain('Menlo');
  });
});

describe('resolveFont', () => {
  it('returns DEFAULT_FONT_FAMILY for default source', async () => {
    const result = await resolveFont({
      fontSource: 'default',
      systemFontFamily: '',
      bundledFont: '',
    });
    expect(result).toBe(DEFAULT_FONT_FAMILY);
  });

  it('returns system font family for system source', async () => {
    const result = await resolveFont({
      fontSource: 'system',
      systemFontFamily: "'Fira Code', monospace",
      bundledFont: '',
    });
    expect(result).toBe("'Fira Code', monospace");
  });

  it('falls back to default if system font is empty', async () => {
    const result = await resolveFont({
      fontSource: 'system',
      systemFontFamily: '',
      bundledFont: '',
    });
    expect(result).toBe(DEFAULT_FONT_FAMILY);
  });

  it('falls back to default for unknown bundled font', async () => {
    const result = await resolveFont({
      fontSource: 'bundled',
      systemFontFamily: '',
      bundledFont: 'nonexistent-font',
    });
    expect(result).toBe(DEFAULT_FONT_FAMILY);
  });

  it('falls back to default for unknown fontSource', async () => {
    const result = await resolveFont({
      fontSource: 'unknown',
      systemFontFamily: '',
      bundledFont: '',
    });
    expect(result).toBe(DEFAULT_FONT_FAMILY);
  });
});
