/**
 * Generate CSS defaults from builtin themes.
 *
 * Outputs the :root (light) and .dark blocks with all
 * theme-derived CSS custom properties, so app.css doesn't
 * need to duplicate values from builtin.ts.
 *
 * Usage: bun run scripts/generate-theme-defaults.ts
 */

import { catppuccinLatte, catppuccinMocha } from '../src/lib/theme/builtin';
import {
  hexToOklch,
  UI_TOKEN_MAP,
  TERMINAL_TOKEN_MAP,
} from '../src/lib/theme/convert';
import type { HubrisTheme } from '../src/lib/theme/types';

function resolve(
  colors: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (colors[key]) return colors[key];
  }
  return undefined;
}

function generateBlock(theme: HubrisTheme): string {
  const lines: string[] = [];

  let prevGroup = '';
  for (const [primary, cssVar, ...fallbacks] of UI_TOKEN_MAP) {
    const hex = resolve(theme.colors, [primary, ...fallbacks]);
    if (hex) {
      const group = cssVar.startsWith('--sidebar')
        ? 'sidebar'
        : cssVar.startsWith('--tab')
          ? 'tab'
          : 'core';
      if (group !== prevGroup && prevGroup) lines.push('');
      prevGroup = group;
      lines.push(`  ${cssVar}: ${hexToOklch(hex)};`);
    }
  }

  lines.push('');
  for (const [primary, cssVar, ...fallbacks] of TERMINAL_TOKEN_MAP) {
    const hex = resolve(theme.colors, [primary, ...fallbacks]);
    if (hex) lines.push(`  ${cssVar}: ${hex};`);
  }

  return lines.join('\n');
}

const lightBlock = generateBlock(catppuccinLatte);
const darkBlock = generateBlock(catppuccinMocha);

console.log(`/* Auto-generated from builtin themes — do not edit. */
/* Run: bun run generate:theme-defaults */

:root {
${lightBlock}
}

.dark {
${darkBlock}
}`);
