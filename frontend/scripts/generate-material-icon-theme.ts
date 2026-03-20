/**
 * Generate a checked-in Material Icon Theme manifest for the explorer.
 *
 * Copies the package SVG icons into `public/material-icon-theme-icons/`
 * and rewrites manifest icon paths to those public URLs.
 *
 * Usage: bun run scripts/generate-material-icon-theme.ts
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { generateManifest, type Manifest } from "material-icon-theme";

const sourceIconsDir = fileURLToPath(
  new URL("../node_modules/material-icon-theme/icons", import.meta.url),
);
const publicIconsDir = fileURLToPath(
  new URL("../public/material-icon-theme-icons", import.meta.url),
);
const generatedManifestFile = fileURLToPath(
  new URL("../src/lib/materialIconTheme.generated.ts", import.meta.url),
);

function rewriteIconPath(iconPath: string): string {
  return `/material-icon-theme-icons/${basename(iconPath)}`;
}

function buildExplorerData(manifest: Manifest) {
  return {
    iconPaths: Object.fromEntries(
      Object.entries(manifest.iconDefinitions).map(([key, definition]) => [
        key,
        rewriteIconPath(definition.iconPath),
      ]),
    ),
    defaults: {
      file: manifest.file ?? "file",
      folder: manifest.folder ?? "folder",
      folderExpanded: manifest.folderExpanded ?? "folder-open",
    },
    associations: {
      fileNames: manifest.fileNames ?? {},
      fileExtensions: manifest.fileExtensions ?? {},
      languageIds: manifest.languageIds ?? {},
      folderNames: manifest.folderNames ?? {},
      folderNamesExpanded: manifest.folderNamesExpanded ?? {},
      light: {
        fileNames: manifest.light?.fileNames ?? {},
        fileExtensions: manifest.light?.fileExtensions ?? {},
        languageIds: manifest.light?.languageIds ?? {},
        folderNames: manifest.light?.folderNames ?? {},
        folderNamesExpanded: manifest.light?.folderNamesExpanded ?? {},
      },
    },
  };
}

const explorerData = buildExplorerData(generateManifest());

rmSync(publicIconsDir, { recursive: true, force: true });
mkdirSync(publicIconsDir, { recursive: true });
cpSync(sourceIconsDir, publicIconsDir, { recursive: true });

writeFileSync(
  generatedManifestFile,
  `/* Auto-generated from material-icon-theme — do not edit. */
/* Run: bun run generate:material-icons */

export const materialIconThemeData = JSON.parse(
  ${JSON.stringify(JSON.stringify(explorerData))}
);
`,
);
