import type { HubrisTheme, VscodeThemeFile } from './types';

/**
 * Generate a URL-safe slug from a theme name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a raw VS Code theme JSON file into a HubrisTheme.
 * Strips tokenColors and other fields we don't need.
 */
export function parseVscodeTheme(
  raw: VscodeThemeFile,
  filename?: string,
): HubrisTheme {
  const name = raw.name || filename?.replace(/\.\w+$/, '') || 'Imported Theme';
  return {
    id: slugify(name),
    name,
    type: raw.type === 'light' ? 'light' : 'dark',
    colors: raw.colors ?? {},
  };
}
