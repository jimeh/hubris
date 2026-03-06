import { describe, it, expect } from "vitest";
import { parseVscodeTheme } from "./parse";
import type { VscodeThemeFile } from "./types";

describe("parseVscodeTheme", () => {
  it("parses a minimal VS Code theme", () => {
    const raw: VscodeThemeFile = {
      name: "My Theme",
      type: "dark",
      colors: { "editor.background": "#1e1e1e" },
    };
    const result = parseVscodeTheme(raw);
    expect(result.id).toBe("my-theme");
    expect(result.name).toBe("My Theme");
    expect(result.type).toBe("dark");
    expect(result.colors["editor.background"]).toBe("#1e1e1e");
    expect(result.builtin).toBeUndefined();
  });

  it("defaults type to dark when missing", () => {
    const raw: VscodeThemeFile = { colors: {} };
    const result = parseVscodeTheme(raw);
    expect(result.type).toBe("dark");
  });

  it("parses light type correctly", () => {
    const raw: VscodeThemeFile = {
      type: "light",
      colors: {},
    };
    const result = parseVscodeTheme(raw);
    expect(result.type).toBe("light");
  });

  it("treats hc as dark", () => {
    const raw: VscodeThemeFile = {
      type: "hc",
      colors: {},
    };
    const result = parseVscodeTheme(raw);
    expect(result.type).toBe("dark");
  });

  it("falls back to filename for name", () => {
    const raw: VscodeThemeFile = { colors: {} };
    const result = parseVscodeTheme(raw, "Dracula.json");
    expect(result.name).toBe("Dracula");
    expect(result.id).toBe("dracula");
  });

  it("falls back to default name when both missing", () => {
    const raw: VscodeThemeFile = { colors: {} };
    const result = parseVscodeTheme(raw);
    expect(result.name).toBe("Imported Theme");
  });

  it("strips tokenColors and other fields", () => {
    const raw: VscodeThemeFile = {
      name: "Full Theme",
      type: "dark",
      colors: { "editor.background": "#000" },
      tokenColors: [{ scope: "comment", settings: {} }],
      semanticHighlighting: true,
      semanticTokenColors: {},
    };
    const result = parseVscodeTheme(raw);
    expect(result).not.toHaveProperty("tokenColors");
    expect(result).not.toHaveProperty("semanticHighlighting");
    expect(result).not.toHaveProperty("semanticTokenColors");
  });

  it("handles empty colors", () => {
    const raw: VscodeThemeFile = { name: "Empty" };
    const result = parseVscodeTheme(raw);
    expect(result.colors).toEqual({});
  });

  it("generates clean slugs", () => {
    const raw: VscodeThemeFile = {
      name: "One Dark Pro++",
      colors: {},
    };
    const result = parseVscodeTheme(raw);
    expect(result.id).toBe("one-dark-pro");
  });
});
