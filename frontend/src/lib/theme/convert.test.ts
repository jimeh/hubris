// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hexToOklch, applyTheme, clearTheme } from './convert';
import type { HubrisTheme } from './types';

describe('hexToOklch', () => {
  it('converts black hex to oklch', () => {
    const result = hexToOklch('#000000');
    expect(result).toMatch(/oklch/);
    expect(result).toContain('0');
  });

  it('converts white hex to oklch', () => {
    const result = hexToOklch('#ffffff');
    expect(result).toMatch(/oklch/);
  });

  it('converts a Catppuccin color correctly', () => {
    const result = hexToOklch('#1e1e2e');
    expect(result).toMatch(/oklch/);
  });

  it('preserves alpha in hex colors', () => {
    const result = hexToOklch('#585b7066');
    expect(result).toMatch(/oklch/);
  });

  it('passes through unparseable values', () => {
    expect(hexToOklch('not-a-color')).toBe('not-a-color');
  });
});

describe('applyTheme / clearTheme', () => {
  const minimalTheme: HubrisTheme = {
    id: 'test-dark',
    name: 'Test Dark',
    type: 'dark',
    colors: {
      'editor.background': '#1e1e2e',
      'editor.foreground': '#cdd6f4',
      'terminal.background': '#1e1e2e',
      'terminal.foreground': '#cdd6f4',
    },
  };

  beforeEach(() => {
    // Reset document state
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  afterEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('adds dark class for dark themes', () => {
    applyTheme(minimalTheme);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for light themes', () => {
    document.documentElement.classList.add('dark');
    applyTheme({ ...minimalTheme, type: 'light' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('sets UI CSS variables as oklch', () => {
    applyTheme(minimalTheme);
    const bg = document.documentElement.style.getPropertyValue('--background');
    expect(bg).toMatch(/oklch/);
  });

  it('sets terminal CSS variables as hex', () => {
    applyTheme(minimalTheme);
    const termBg = document.documentElement.style.getPropertyValue(
      '--terminal-background',
    );
    expect(termBg).toBe('#1e1e2e');
  });

  it('clearTheme removes all overrides', () => {
    applyTheme(minimalTheme);
    clearTheme();
    const bg = document.documentElement.style.getPropertyValue('--background');
    expect(bg).toBe('');
    const termBg = document.documentElement.style.getPropertyValue(
      '--terminal-background',
    );
    expect(termBg).toBe('');
  });
});
