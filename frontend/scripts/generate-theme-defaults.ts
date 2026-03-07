/**
 * Generate CSS defaults from builtin themes.
 *
 * Outputs the :root (light) and .dark blocks with all
 * theme-derived CSS custom properties, so app.css doesn't
 * need to duplicate values from builtin.ts.
 *
 * Usage: bun run scripts/generate-theme-defaults.ts
 */

import { hubrisLight, hubrisDark } from "../src/lib/theme/builtin";
import {
  TERMINAL_THEME_TOKENS,
  UI_THEME_TOKENS,
  type HubrisTheme,
} from "../src/lib/theme/types";

function generateBlock(theme: HubrisTheme): string {
  const lines: string[] = [];

  let prevGroup = "";
  for (const token of UI_THEME_TOKENS) {
    const cssVar = `--${token}`;
    const group = cssVar.startsWith("--sidebar")
      ? "sidebar"
      : cssVar.startsWith("--tab")
        ? "tab"
        : cssVar.startsWith("--chart")
          ? "chart"
          : cssVar.startsWith("--quick-input")
            ? "quick-input"
            : "core";
    if (group !== prevGroup && prevGroup) lines.push("");
    prevGroup = group;
    lines.push(`  ${cssVar}: ${theme.tokens[token]};`);
  }

  lines.push("");
  for (const token of TERMINAL_THEME_TOKENS) {
    lines.push(`  --${token}: ${theme.tokens[token]};`);
  }

  return lines.join("\n");
}

const lightBlock = generateBlock(hubrisLight);
const darkBlock = generateBlock(hubrisDark);

console.log(`/* Auto-generated from builtin themes — do not edit. */
/* Run: bun run generate:theme-defaults */

:root {
${lightBlock}
}

.dark {
${darkBlock}
}`);
