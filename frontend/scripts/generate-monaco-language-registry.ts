/**
 * Generate a checked-in Rust registry from Monaco language metadata.
 *
 * Usage: bun run scripts/generate-monaco-language-registry.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Contribution = {
  id: string;
  order: number;
  extensions: string[];
  filenames: string[];
  firstLine: string | null;
};

type FirstLineRule = "NodeShebang" | "PythonShebang" | "XmlLike";

const monacoContributionFile = fileURLToPath(
  new URL(
    "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js",
    import.meta.url,
  ),
);
const languageRoot = fileURLToPath(
  new URL("../node_modules/monaco-editor/esm/vs/language/", import.meta.url),
);
const generatedRustFile = fileURLToPath(
  new URL(
    "../../crates/server/src/api/monaco_languages.generated.rs",
    import.meta.url,
  ),
);

const FIRST_LINE_RULES = new Map<string, FirstLineRule>([
  ["^#!.*\\\\bnode", "NodeShebang"],
  ["^#!/.*\\\\bpython[0-9.-]*\\\\b", "PythonShebang"],
  ["(\\\\<\\\\?xml.*)|(\\\\<svg)|(\\\\<\\\\!doctype\\\\s+svg)", "XmlLike"],
]);

function parseStringArray(source: string, field: string): string[] {
  const block =
    source.match(new RegExp(`${field}:\\s*\\[(.*?)\\]`, "s"))?.[1] ?? "";

  return [...block.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
}

function parseContribution(file: string, order: number): Contribution | null {
  const source = readFileSync(file, "utf8");
  const id =
    source.match(/languages\.register\(\{\s*id:\s*"([^"]+)"/s)?.[1] ??
    source.match(/id:\s*"([^"]+)"/)?.[1];

  if (!id) {
    return null;
  }

  const firstLine = source.match(/firstLine:\s*"((?:\\.|[^"])*)"/)?.[1] ?? null;
  if (firstLine && !FIRST_LINE_RULES.has(firstLine)) {
    throw new Error(`Unhandled Monaco firstLine rule for ${id}: ${firstLine}`);
  }

  return {
    id,
    order,
    extensions: parseStringArray(source, "extensions"),
    filenames: parseStringArray(source, "filenames"),
    firstLine,
  };
}

function orderedBasicContributionFiles(): string[] {
  const source = readFileSync(monacoContributionFile, "utf8");

  return [...source.matchAll(/\.\/([^/]+)\/[^"]+\.contribution\.js/g)].map(
    (match) =>
      fileURLToPath(
        new URL(
          `../node_modules/monaco-editor/esm/vs/basic-languages/${match[1]}/${match[1]}.contribution.js`,
          import.meta.url,
        ),
      ),
  );
}

function extraContributionFiles(): string[] {
  return readdirSync(languageRoot)
    .map((dirName) => `${languageRoot}${dirName}/monaco.contribution.js`)
    .filter((file) => {
      try {
        const source = readFileSync(file, "utf8");
        return source.includes("languages.register({");
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}

function rustString(value: string): string {
  return JSON.stringify(value);
}

function writeRustRegistry(contributions: Contribution[]): void {
  const filenameMap = new Map<string, string>();
  const extensionEntries: Array<{
    suffix: string;
    language: string;
    order: number;
  }> = [];
  const firstLineMap = new Map<FirstLineRule, string>();

  for (const contribution of contributions) {
    for (const name of contribution.filenames) {
      filenameMap.set(name.toLowerCase(), contribution.id);
    }

    for (const extension of contribution.extensions) {
      extensionEntries.push({
        suffix: extension.toLowerCase(),
        language: contribution.id,
        order: contribution.order,
      });
    }

    if (contribution.firstLine) {
      const rule = FIRST_LINE_RULES.get(contribution.firstLine);
      if (!rule) {
        throw new Error(
          `Missing first-line mapping for ${contribution.id}: ${contribution.firstLine}`,
        );
      }
      firstLineMap.set(rule, contribution.id);
    }
  }

  const filenameEntries = [...filenameMap.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const dedupedExtensions = new Map<
    string,
    { language: string; order: number }
  >();
  for (const entry of extensionEntries) {
    dedupedExtensions.set(entry.suffix, {
      language: entry.language,
      order: entry.order,
    });
  }
  const sortedExtensions = [...dedupedExtensions.entries()]
    .map(([suffix, value]) => ({
      suffix,
      language: value.language,
      order: value.order,
    }))
    .sort((left, right) => {
      const lengthDelta = right.suffix.length - left.suffix.length;
      if (lengthDelta !== 0) {
        return lengthDelta;
      }
      const orderDelta = right.order - left.order;
      if (orderDelta !== 0) {
        return orderDelta;
      }
      return left.suffix.localeCompare(right.suffix);
    });

  const firstLineEntries = [...firstLineMap.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const body = `/* Auto-generated from monaco-editor language contributions — do not edit. */
/* Run: cd frontend && bun run generate:monaco-languages */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoFilenameAssociation {
    pub filename: &'static str,
    pub language: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoExtensionAssociation {
    pub suffix: &'static str,
    pub language: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonacoFirstLineRule {
    NodeShebang,
    PythonShebang,
    XmlLike,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoFirstLineAssociation {
    pub rule: MonacoFirstLineRule,
    pub language: &'static str,
}

pub const MONACO_FILENAME_ASSOCIATIONS: &[MonacoFilenameAssociation] = &[
${filenameEntries
  .map(
    ([filename, language]) =>
      `    MonacoFilenameAssociation { filename: ${rustString(filename)}, language: ${rustString(language)} },`,
  )
  .join("\n")}
];

pub const MONACO_EXTENSION_ASSOCIATIONS: &[MonacoExtensionAssociation] = &[
${sortedExtensions
  .map(
    ({ suffix, language }) =>
      `    MonacoExtensionAssociation { suffix: ${rustString(suffix)}, language: ${rustString(language)} },`,
  )
  .join("\n")}
];

pub const MONACO_FIRST_LINE_ASSOCIATIONS: &[MonacoFirstLineAssociation] = &[
${firstLineEntries
  .map(
    ([rule, language]) =>
      `    MonacoFirstLineAssociation { rule: MonacoFirstLineRule::${rule}, language: ${rustString(language)} },`,
  )
  .join("\n")}
];
`;

  writeFileSync(generatedRustFile, body);

  const rustfmt = spawnSync("rustfmt", [generatedRustFile], {
    stdio: "inherit",
  });
  if (rustfmt.status !== 0) {
    throw new Error("rustfmt failed for monaco language registry");
  }
}

const contributionFiles = [
  ...orderedBasicContributionFiles(),
  ...extraContributionFiles(),
];
const contributions = contributionFiles.flatMap((file, index) => {
  const contribution = parseContribution(file, index);
  return contribution ? [contribution] : [];
});

writeRustRegistry(contributions);
