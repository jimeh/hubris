import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extraContributionFilesForRoot,
  sourceHasRegistrationBlock,
} from "./monaco-language-registry-generator";
import { orderedBasicContributionFilesForManifest } from "./generate-monaco-language-registry";

function createContributionFile(
  root: string,
  dirName: string,
  content: string,
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "monaco.contribution.js");
  writeFileSync(file, content);
  return file;
}

describe("Monaco language registry generator", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes both Monaco registration forms", () => {
    expect(
      sourceHasRegistrationBlock('languages.register({ id: "json" });'),
    ).toBe(true);
    expect(sourceHasRegistrationBlock('registerLanguage({ id: "cpp" });')).toBe(
      true,
    );
    expect(sourceHasRegistrationBlock("export const value = 1;")).toBe(false);
  });

  it("includes extra contribution files for both supported registration forms", () => {
    const root = mkdtempSync(join(tmpdir(), "monaco-languages-"));
    tempDirs.push(root);

    const languageRegisterFile = createContributionFile(
      root,
      "json",
      'languages.register({ id: "json" });\n',
    );
    const registerLanguageFile = createContributionFile(
      root,
      "custom",
      'registerLanguage({ id: "custom" });\n',
    );
    createContributionFile(root, "ignored", "export const ignored = true;\n");

    expect(extraContributionFilesForRoot(root)).toEqual([
      registerLanguageFile,
      languageRegisterFile,
    ]);
  });

  it("does not read Monaco files when the generator entrypoint is imported", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();

      return {
        default: actual,
        ...actual,
        readFileSync: vi.fn(() => {
          throw new Error("readFileSync should not run at import time");
        }),
      };
    });

    await expect(
      import("./generate-monaco-language-registry"),
    ).resolves.toBeDefined();
  });

  it("finds basic language contributions from the editor.main.js manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "monaco-editor-main-"));
    tempDirs.push(root);

    const editorDir = join(root, "editor");
    const basicDir = join(root, "basic-languages");
    mkdirSync(editorDir, { recursive: true });
    mkdirSync(join(basicDir, "abap"), { recursive: true });
    mkdirSync(join(basicDir, "cpp"), { recursive: true });

    const manifest = join(editorDir, "editor.main.js");
    writeFileSync(
      manifest,
      [
        "import '../language/css/monaco.contribution.js';",
        "import '../basic-languages/abap/abap.contribution.js';",
        "import '../basic-languages/cpp/cpp.contribution.js';",
      ].join("\n"),
    );

    expect(orderedBasicContributionFilesForManifest(manifest)).toEqual([
      join(basicDir, "abap", "abap.contribution.js"),
      join(basicDir, "cpp", "cpp.contribution.js"),
    ]);
  });
});
