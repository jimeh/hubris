/**
 * Copy the desktop runtime config type into the web app.
 *
 * Usage: bun run scripts/generate-desktop-runtime-config.ts
 */

const sourcePath = "apps/desktop/src/desktopRuntimeConfigShared.ts";
const sourceFile = new URL(
  "../../desktop/src/desktopRuntimeConfigShared.ts",
  import.meta.url,
);
const source = await Bun.file(sourceFile).text();

process.stdout.write(
  `/* Auto-generated from ${sourcePath} — do not edit. */\n` + source,
);
