import { describe, expect, it } from "vitest";

describe("monaco-editor package root", () => {
  it("registers rich and basic languages", async () => {
    const monaco = await import("monaco-editor");
    const languageIds = new Set(
      monaco.languages.getLanguages().map((language) => language.id),
    );

    expect(languageIds.has("json")).toBe(true);
    expect(languageIds.has("rust")).toBe(true);
  }, 15_000);
});
