#!/usr/bin/env bun
/**
 * Downloads VS Code built-in color themes from the latest release,
 * resolves `include` chains, strips JSONC comments, and writes
 * self-contained theme JSON files for embedding in the Hubris server.
 *
 * Usage: bun run scripts/download-vscode-themes.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const REPO = "microsoft/vscode";
const OUTPUT_DIR = join(
  dirname(import.meta.dir),
  "apps/server/data/editor-themes/vscode",
);

// Skip icon themes and non-color-theme extensions.
const SKIP_EXTENSIONS = new Set(["theme-seti"]);

// Map uiTheme values to theme type.
function uiThemeToType(uiTheme: string): string {
  switch (uiTheme) {
    case "vs":
    case "hc-light":
      return "light";
    default:
      return "dark";
  }
}

// Slugify a theme ID for use as a filename.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Strip JSONC comments (// and /* */) and trailing commas.
function stripJsonc(input: string): string {
  let out = "";
  const len = input.length;
  let i = 0;

  while (i < len) {
    // String literal — pass through.
    if (input[i] === '"') {
      out += '"';
      i++;
      while (i < len) {
        if (input[i] === "\\" && i + 1 < len) {
          out += input[i] + input[i + 1];
          i += 2;
        } else if (input[i] === '"') {
          out += '"';
          i++;
          break;
        } else {
          out += input[i];
          i++;
        }
      }
      continue;
    }

    // Line comment.
    if (i + 1 < len && input[i] === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < len && input[i] !== "\n") i++;
      continue;
    }

    // Block comment.
    if (i + 1 < len && input[i] === "/" && input[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += input[i];
    i++;
  }

  // Strip trailing commas before ] and }.
  let result = "";
  for (i = 0; i < out.length; i++) {
    if (out[i] === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (j < out.length && (out[j] === "]" || out[j] === "}")) {
        continue; // skip trailing comma
      }
    }
    result += out[i];
  }

  return result;
}

// Parse a JSONC string.
function parseJsonc(input: string): unknown {
  return JSON.parse(stripJsonc(input));
}

type ThemeJson = {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
  [key: string]: unknown;
};

type ThemeContribution = {
  id?: string;
  label: string;
  uiTheme: string;
  path: string;
};

type PackageJson = {
  name: string;
  displayName?: string;
  contributes?: {
    themes?: ThemeContribution[];
  };
};

// Resolve a theme file, following `include` chains.
// `filePath` is the absolute path to the theme JSON file.
async function resolveTheme(
  filePath: string,
  visited: Set<string> = new Set(),
): Promise<ThemeJson> {
  if (visited.has(filePath)) {
    console.warn(`  Circular include detected: ${filePath}`);
    return {};
  }
  visited.add(filePath);

  if (!existsSync(filePath)) {
    console.warn(`  Missing theme file: ${filePath}`);
    return {};
  }

  const raw = await Bun.file(filePath).text();
  let theme: ThemeJson;
  try {
    theme = parseJsonc(raw) as ThemeJson;
  } catch (e) {
    console.warn(`  Failed to parse ${filePath}: ${e}`);
    return {};
  }

  if (!theme.include) {
    // Base theme — return as-is (minus include and $schema).
    const { include: _, $schema: __, ...rest } = theme;
    return rest;
  }

  // Resolve the parent — include path is relative to this file's dir.
  const parentPath = join(dirname(filePath), theme.include);
  const parent = await resolveTheme(parentPath, visited);

  // Merge: parent is the base, child overrides.
  const { include: _, $schema: __, ...child } = theme;

  const merged: ThemeJson = { ...parent };

  // Colors: child overrides parent.
  if (parent.colors || child.colors) {
    merged.colors = { ...(parent.colors ?? {}), ...(child.colors ?? {}) };
  }

  // tokenColors: concatenate (child after parent for higher specificity).
  if (parent.tokenColors || child.tokenColors) {
    merged.tokenColors = [
      ...(parent.tokenColors ?? []),
      ...(child.tokenColors ?? []),
    ];
  }

  // semanticTokenColors: child overrides parent.
  if (parent.semanticTokenColors || child.semanticTokenColors) {
    merged.semanticTokenColors = {
      ...(parent.semanticTokenColors ?? {}),
      ...(child.semanticTokenColors ?? {}),
    };
  }

  // semanticHighlighting: child overrides parent.
  if (child.semanticHighlighting !== undefined) {
    merged.semanticHighlighting = child.semanticHighlighting;
  }

  // name from child if present.
  if (child.name) merged.name = child.name;
  if (child.type) merged.type = child.type;

  return merged;
}

async function main() {
  // 1. Get latest release tag.
  console.log("Fetching latest VS Code release tag...");
  const releaseRes = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    },
  );
  if (!releaseRes.ok) {
    throw new Error(
      `Failed to fetch release: ${releaseRes.status} ${releaseRes.statusText}`,
    );
  }
  const release = (await releaseRes.json()) as { tag_name: string };
  const tag = release.tag_name;
  console.log(`Latest release: ${tag}`);

  // 2. Download source tarball.
  const tarballUrl = `https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`;
  console.log(`Downloading tarball: ${tarballUrl}`);

  const tmpDir = join(
    import.meta.dir,
    ".vscode-themes-tmp",
  );
  mkdirSync(tmpDir, { recursive: true });
  const tarPath = join(tmpDir, "vscode.tar.gz");

  execSync(`curl -sL -o "${tarPath}" "${tarballUrl}"`, {
    stdio: "inherit",
  });

  // 3. Extract theme-* extension directories.
  console.log("Extracting theme extensions...");
  const extractDir = join(tmpDir, "extracted");
  mkdirSync(extractDir, { recursive: true });

  // The tarball root is vscode-{tag}/ — extract only extensions/theme-*
  execSync(
    `tar xzf "${tarPath}" -C "${extractDir}" --strip-components=1 "*/extensions/theme-*"`,
    { stdio: "inherit" },
  );

  const extensionsDir = join(extractDir, "extensions");

  // 4. Process each theme extension.
  mkdirSync(OUTPUT_DIR, { recursive: true });
  let totalThemes = 0;

  const entries = await Array.fromAsync(
    new Bun.Glob("theme-*").scan({
      cwd: extensionsDir,
      onlyFiles: false,
    }),
  );

  for (const extName of entries.sort()) {
    if (SKIP_EXTENSIONS.has(extName)) {
      console.log(`Skipping ${extName} (not a color theme)`);
      continue;
    }

    const extDir = join(extensionsDir, extName);
    const pkgPath = join(extDir, "package.json");
    if (!existsSync(pkgPath)) continue;

    let pkg: PackageJson;
    try {
      pkg = (await Bun.file(pkgPath).json()) as PackageJson;
    } catch {
      console.warn(`  Failed to parse ${pkgPath}`);
      continue;
    }

    const themes = pkg.contributes?.themes ?? [];
    if (themes.length === 0) continue;

    console.log(
      `Processing ${extName} (${themes.length} theme${themes.length > 1 ? "s" : ""})`,
    );

    // Determine themes directory (where theme JSON files live).
    // The `path` in contributions is relative to the extension root.
    for (const contrib of themes) {
      if (!contrib.path) continue;

      const themeType = uiThemeToType(contrib.uiTheme);
      const themeId = contrib.id ?? contrib.label;
      const themeName = themeId.replace(/%\w+%/g, "").trim() || extName;

      // Resolve the theme file relative to the extension root.
      const themeFilePath = join(extDir, contrib.path);
      const resolved = await resolveTheme(themeFilePath);
      if (
        !resolved.colors &&
        !resolved.tokenColors?.length
      ) {
        console.warn(`  Skipping empty theme: ${themeName}`);
        continue;
      }

      // Set name and type.
      resolved.name = themeName;
      resolved.type = themeType;

      // Write to output.
      const slug = slugify(themeName);
      const outPath = join(OUTPUT_DIR, `${slug}.json`);
      writeFileSync(
        outPath,
        JSON.stringify(resolved, null, 2) + "\n",
      );
      console.log(`  → ${slug}.json (${themeType})`);
      totalThemes++;
    }
  }

  // 5. Cleanup.
  execSync(`rm -rf "${tmpDir}"`);

  console.log(
    `\nDone! ${totalThemes} themes written to ${OUTPUT_DIR}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
