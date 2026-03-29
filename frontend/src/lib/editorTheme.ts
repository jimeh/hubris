import type * as monacoTypes from "monaco-editor";
import type { VscodeThemeJson } from "@/lib/api";

type MonacoThemeData = monacoTypes.editor.IStandaloneThemeData;
type TokenRule = monacoTypes.editor.ITokenThemeRule;

/**
 * Convert a VS Code theme JSON structure into Monaco's
 * IStandaloneThemeData format.
 *
 * Key differences between the two APIs:
 * - Monaco `ITokenThemeRule.foreground` expects hex WITHOUT `#`
 * - Monaco `colors` map expects values WITH `#`
 */
export function convertVscodeThemeToMonaco(
  theme: VscodeThemeJson,
): MonacoThemeData {
  const base: MonacoThemeData["base"] =
    theme.type === "light" ? "vs" : "vs-dark";

  const rules: TokenRule[] = [];
  for (const tokenColor of theme.tokenColors) {
    const scopes = Array.isArray(tokenColor.scope)
      ? tokenColor.scope
      : tokenColor.scope
        ? [tokenColor.scope]
        : [""];

    for (const scope of scopes) {
      const rule: TokenRule = { token: scope };
      if (tokenColor.settings.foreground) {
        rule.foreground = stripHash(tokenColor.settings.foreground);
      }
      if (tokenColor.settings.fontStyle) {
        rule.fontStyle = tokenColor.settings.fontStyle;
      }
      if (tokenColor.settings.background) {
        rule.background = stripHash(tokenColor.settings.background);
      }
      rules.push(rule);
    }
  }

  const colors: Record<string, string> = { ...theme.colors };

  return { base, inherit: true, rules, colors };
}

function stripHash(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1) : hex;
}
