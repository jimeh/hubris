import { describe, expect, it } from "vitest";

import type { VscodeThemeJson } from "@/lib/api";

import { convertVscodeThemeToMonaco } from "./editorTheme";

function makeTheme(overrides: Partial<VscodeThemeJson> = {}): VscodeThemeJson {
  return {
    name: "Test",
    type: "dark",
    colors: {},
    tokenColors: [],
    ...overrides,
  };
}

describe("convertVscodeThemeToMonaco", () => {
  it("selects vs-dark base for dark themes", () => {
    const result = convertVscodeThemeToMonaco(makeTheme({ type: "dark" }));
    expect(result.base).toBe("vs-dark");
  });

  it("selects vs base for light themes", () => {
    const result = convertVscodeThemeToMonaco(makeTheme({ type: "light" }));
    expect(result.base).toBe("vs");
  });

  it("passes colors through unchanged", () => {
    const colors = {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#d4d4d4",
    };
    const result = convertVscodeThemeToMonaco(makeTheme({ colors }));
    expect(result.colors).toEqual(colors);
  });

  it("strips # from token foreground and background", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [
          {
            scope: "comment",
            settings: { foreground: "#6A9955", background: "#1e1e1e" },
          },
        ],
      }),
    );
    expect(result.rules).toEqual([
      { token: "comment", foreground: "6A9955", background: "1e1e1e" },
    ]);
  });

  it("passes through foreground without #", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [{ scope: "keyword", settings: { foreground: "C586C0" } }],
      }),
    );
    expect(result.rules[0].foreground).toBe("C586C0");
  });

  it("includes fontStyle when present", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [
          {
            scope: "keyword",
            settings: { foreground: "#C586C0", fontStyle: "bold" },
          },
        ],
      }),
    );
    expect(result.rules[0].fontStyle).toBe("bold");
  });

  it("splits comma-separated scope strings", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [
          {
            scope: "markup.bold, markup.italic",
            settings: { foreground: "#DCDCAA" },
          },
        ],
      }),
    );
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0].token).toBe("markup.bold");
    expect(result.rules[1].token).toBe("markup.italic");
  });

  it("handles scope as array of strings", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [
          {
            scope: ["entity.name.function", "support.function"],
            settings: { foreground: "#DCDCAA" },
          },
        ],
      }),
    );
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0].token).toBe("entity.name.function");
    expect(result.rules[1].token).toBe("support.function");
  });

  it("splits comma-separated entries within scope arrays", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [
          {
            scope: ["entity.name.class, entity.name.type", "keyword"],
            settings: { foreground: "#4EC9B0" },
          },
        ],
      }),
    );
    expect(result.rules.map((r) => r.token)).toEqual([
      "entity.name.class",
      "entity.name.type",
      "keyword",
    ]);
  });

  it("uses empty token for missing scope", () => {
    const result = convertVscodeThemeToMonaco(
      makeTheme({
        tokenColors: [{ settings: { foreground: "#D4D4D4" } }],
      }),
    );
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].token).toBe("");
  });

  it("handles undefined tokenColors gracefully", () => {
    const theme = {
      name: "Colors Only",
      type: "dark",
      colors: {},
    } as VscodeThemeJson;
    const result = convertVscodeThemeToMonaco(theme);
    expect(result.rules).toEqual([]);
  });

  it("always sets inherit to true", () => {
    const result = convertVscodeThemeToMonaco(makeTheme());
    expect(result.inherit).toBe(true);
  });
});
