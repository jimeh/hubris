// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BUNDLED_FONTS,
  DEFAULT_FONT_FAMILY,
  resolveFont,
  loadBundledFont,
} from './fonts';

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

describe('loadBundledFont', () => {
  beforeEach(() => {
    // Mock Font Loading API (not in jsdom)
    Object.defineProperty(document, 'fonts', {
      value: { load: vi.fn().mockResolvedValue([]) },
      writable: true,
      configurable: true,
    });

    // Clean up any style elements from previous tests
    document
      .querySelectorAll('style[id^="bundled-font-"]')
      .forEach((el) => el.remove());
  });

  it('throws for unknown font ID', async () => {
    await expect(loadBundledFont('nope')).rejects.toThrow(
      'Unknown bundled font: nope',
    );
  });

  it('injects @font-face style element', async () => {
    await loadBundledFont('hack-nf');

    const style = document.getElementById('bundled-font-hack-nf');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('Hack Nerd Font');
    expect(style!.textContent).toContain('HackNerdFont-Regular');
    expect(style!.textContent).toContain('HackNerdFont-Bold');
  });

  it('returns the CSS font-family name', async () => {
    const family = await loadBundledFont('hack-nf');
    expect(family).toBe('Hack Nerd Font');
  });

  it('calls document.fonts.load for both weights', async () => {
    await loadBundledFont('firacode-nf');

    expect(document.fonts.load).toHaveBeenCalledWith(
      "400 16px 'FiraCode Nerd Font'",
    );
    expect(document.fonts.load).toHaveBeenCalledWith(
      "700 16px 'FiraCode Nerd Font'",
    );
  });

  it('does not create duplicate style on retry', async () => {
    // Pre-inject a style element to simulate a failed previous load
    const existing = document.createElement('style');
    existing.id = 'bundled-font-geistmono-nf';
    existing.textContent = 'existing';
    document.head.appendChild(existing);

    await loadBundledFont('geistmono-nf');

    // Should not have created a second element
    const styles = document.querySelectorAll('#bundled-font-geistmono-nf');
    expect(styles).toHaveLength(1);
    // Original content preserved (not replaced)
    expect(styles[0].textContent).toBe('existing');
  });
});
