// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyTheme,
  clearTheme,
  computeThemeVars,
  applyComputedVars,
} from "./convert";
import { hubrisDark, hubrisLight } from "./builtin";
import { ALL_THEME_TOKENS } from "./types";

describe("applyTheme / clearTheme", () => {
  beforeEach(() => {
    // Reset document state
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  it("adds dark class for dark themes", () => {
    applyTheme(hubrisDark);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes dark class for light themes", () => {
    document.documentElement.classList.add("dark");
    applyTheme(hubrisLight);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("sets native UI and chart tokens", () => {
    applyTheme(hubrisDark);
    const bg = document.documentElement.style.getPropertyValue("--background");
    expect(bg).toBe(hubrisDark.tokens.background);
    expect(document.documentElement.style.getPropertyValue("--chart-3")).toBe(
      hubrisDark.tokens["chart-3"],
    );
    expect(
      document.documentElement.style.getPropertyValue(
        "--destructive-foreground",
      ),
    ).toBe(hubrisDark.tokens["destructive-foreground"]);
  });

  it("sets terminal CSS variables as hex", () => {
    applyTheme(hubrisDark);
    const termBg = document.documentElement.style.getPropertyValue(
      "--terminal-background",
    );
    expect(termBg).toBe(hubrisDark.tokens["terminal-background"]);
  });

  it("clearTheme removes all overrides", () => {
    applyTheme(hubrisDark);
    clearTheme();
    const bg = document.documentElement.style.getPropertyValue("--background");
    expect(bg).toBe("");
    const termBg = document.documentElement.style.getPropertyValue(
      "--terminal-background",
    );
    expect(termBg).toBe("");
  });
});

describe("computeThemeVars", () => {
  it("returns isDark true for dark themes", () => {
    const result = computeThemeVars(hubrisDark);
    expect(result.isDark).toBe(true);
  });

  it("returns isDark false for light themes", () => {
    const result = computeThemeVars(hubrisLight);
    expect(result.isDark).toBe(false);
  });

  it("writes the complete native token set", () => {
    const result = computeThemeVars(hubrisDark);
    expect(Object.keys(result.vars)).toHaveLength(ALL_THEME_TOKENS.length);
    expect(result.vars["--sidebar-accent"]).toBe(
      hubrisDark.tokens["sidebar-accent"],
    );
    expect(result.vars["--tab-border"]).toBe(hubrisDark.tokens["tab-border"]);
    expect(result.vars["--terminal-background"]).toBe(
      hubrisDark.tokens["terminal-background"],
    );
  });
});

describe("applyComputedVars", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  it("sets dark class when isDark is true", () => {
    applyComputedVars({ isDark: true, vars: {} });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes dark class when isDark is false", () => {
    document.documentElement.classList.add("dark");
    applyComputedVars({ isDark: false, vars: {} });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies CSS vars to document", () => {
    applyComputedVars({
      isDark: false,
      vars: { "--background": "oklch(1 0 0)", "--terminal-background": "#fff" },
    });
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("oklch(1 0 0)");
    expect(
      document.documentElement.style.getPropertyValue("--terminal-background"),
    ).toBe("#fff");
  });
});
