import { parse, formatCss, converter } from 'culori';
import type { HubrisTheme } from './types';

const toOklch = converter('oklch');

/**
 * Convert a hex color string to an oklch() CSS value.
 * Preserves alpha channel if present.
 */
export function hexToOklch(hex: string): string {
  const color = parse(hex);
  if (!color) return hex; // unparseable, pass through
  const converted = toOklch(color);
  return formatCss(converted);
}

/**
 * Map from VS Code color key to Hubris CSS variable name.
 * Tuple: [vscodeKey, cssVar, ...fallbackVscodeKeys]
 *
 * UI tokens are converted to OKLCH before being set.
 */
const UI_TOKEN_MAP: [string, string, ...string[]][] = [
  // Core
  ['editor.background', '--background'],
  ['editor.foreground', '--foreground', 'foreground'],
  ['editorWidget.background', '--card', 'editor.background'],
  ['editorWidget.foreground', '--card-foreground', 'editor.foreground'],
  ['editorWidget.background', '--popover', 'editor.background'],
  ['editorWidget.foreground', '--popover-foreground', 'editor.foreground'],
  ['button.background', '--primary'],
  ['button.foreground', '--primary-foreground'],
  ['button.secondaryBackground', '--secondary'],
  ['button.secondaryForeground', '--secondary-foreground', 'editor.foreground'],
  ['tab.inactiveBackground', '--muted', 'editorGroupHeader.tabsBackground'],
  ['tab.inactiveForeground', '--muted-foreground'],
  ['list.hoverBackground', '--accent'],
  ['list.hoverForeground', '--accent-foreground', 'editor.foreground'],
  ['errorForeground', '--destructive'],
  ['panel.border', '--border', 'sideBar.border', 'editorGroup.border'],
  ['input.background', '--input'],
  ['focusBorder', '--ring'],
  // Sidebar
  ['sideBar.background', '--sidebar'],
  ['sideBar.foreground', '--sidebar-foreground', 'editor.foreground'],
  ['list.activeSelectionBackground', '--sidebar-primary'],
  ['list.activeSelectionForeground', '--sidebar-primary-foreground'],
  ['list.hoverBackground', '--sidebar-accent'],
  ['list.hoverForeground', '--sidebar-accent-foreground', 'editor.foreground'],
  ['sideBar.border', '--sidebar-border', 'panel.border', 'editorGroup.border'],
  ['focusBorder', '--sidebar-ring'],
  // Tab bar
  ['editorGroupHeader.tabsBackground', '--tab-bar', 'sideBar.background'],
  ['tab.activeBackground', '--tab-active', 'editor.background'],
  ['tab.activeForeground', '--tab-active-foreground', 'editor.foreground'],
  ['tab.inactiveForeground', '--tab-inactive-foreground'],
  ['tab.border', '--tab-border', 'editorGroup.border', 'panel.border'],
];

/**
 * Terminal tokens stay as hex (xterm.js consumes hex).
 */
const TERMINAL_TOKEN_MAP: [string, string, ...string[]][] = [
  ['terminal.background', '--terminal-background', 'editor.background'],
  ['terminal.foreground', '--terminal-foreground', 'editor.foreground'],
  ['terminalCursor.foreground', '--terminal-cursor'],
  ['terminal.selectionBackground', '--terminal-selection'],
  ['terminal.ansiBlack', '--terminal-ansi-black'],
  ['terminal.ansiRed', '--terminal-ansi-red'],
  ['terminal.ansiGreen', '--terminal-ansi-green'],
  ['terminal.ansiYellow', '--terminal-ansi-yellow'],
  ['terminal.ansiBlue', '--terminal-ansi-blue'],
  ['terminal.ansiMagenta', '--terminal-ansi-magenta'],
  ['terminal.ansiCyan', '--terminal-ansi-cyan'],
  ['terminal.ansiWhite', '--terminal-ansi-white'],
  ['terminal.ansiBrightBlack', '--terminal-ansi-bright-black'],
  ['terminal.ansiBrightRed', '--terminal-ansi-bright-red'],
  ['terminal.ansiBrightGreen', '--terminal-ansi-bright-green'],
  ['terminal.ansiBrightYellow', '--terminal-ansi-bright-yellow'],
  ['terminal.ansiBrightBlue', '--terminal-ansi-bright-blue'],
  ['terminal.ansiBrightMagenta', '--terminal-ansi-bright-magenta'],
  ['terminal.ansiBrightCyan', '--terminal-ansi-bright-cyan'],
  ['terminal.ansiBrightWhite', '--terminal-ansi-bright-white'],
];

/**
 * Resolve a color value from a theme using a priority
 * chain of VS Code keys.
 */
function resolve(
  colors: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (colors[key]) return colors[key];
  }
  return undefined;
}

/** All CSS var names we write, for cleanup. */
const ALL_CSS_VARS = [
  ...UI_TOKEN_MAP.map(([, v]) => v),
  ...TERMINAL_TOKEN_MAP.map(([, v]) => v),
];

/**
 * Apply a theme to the document, setting CSS custom
 * properties on <html>.
 */
export function applyTheme(theme: HubrisTheme): void {
  const root = document.documentElement;
  const c = theme.colors;

  // Set dark/light class
  root.classList.toggle('dark', theme.type === 'dark');

  // UI tokens → OKLCH
  for (const [primary, cssVar, ...fallbacks] of UI_TOKEN_MAP) {
    const hex = resolve(c, [primary, ...fallbacks]);
    if (hex) {
      root.style.setProperty(cssVar, hexToOklch(hex));
    }
  }

  // Terminal tokens → hex passthrough
  for (const [primary, cssVar, ...fallbacks] of TERMINAL_TOKEN_MAP) {
    const hex = resolve(c, [primary, ...fallbacks]);
    if (hex) {
      root.style.setProperty(cssVar, hex);
    }
  }
}

/**
 * Remove all theme overrides from <html>, reverting to
 * app.css defaults.
 */
export function clearTheme(): void {
  const root = document.documentElement;
  for (const v of ALL_CSS_VARS) {
    root.style.removeProperty(v);
  }
}
