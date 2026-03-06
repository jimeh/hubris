// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { deterministicTagStyle } from "./deterministicTagColor";

function styleVar(style: string, key: string): string {
  const entries = style
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [prop, ...rest] = entry.split(":");
      return [prop.trim(), rest.join(":").trim()] as const;
    });
  const found = entries.find(([prop]) => prop === key);
  return found?.[1] ?? "";
}

describe("deterministicTagStyle", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("returns stable style output for the same key", () => {
    document.documentElement.style.setProperty(
      "--popover",
      "oklch(0.22 0.02 260)",
    );

    const first = deterministicTagStyle("feature/login");
    const second = deterministicTagStyle("feature/login");

    expect(first).toBe(second);
  });

  it("uses different hue values for different keys", () => {
    document.documentElement.style.setProperty(
      "--popover",
      "oklch(0.22 0.02 260)",
    );

    const one = styleVar(deterministicTagStyle("main"), "--tag-seed");
    const two = styleVar(deterministicTagStyle("release"), "--tag-seed");

    expect(one).not.toBe(two);
  });

  it("adapts mix strengths for dark vs light surfaces", () => {
    document.documentElement.style.setProperty(
      "--popover",
      "oklch(0.22 0.02 260)",
    );
    const dark = deterministicTagStyle("main");

    document.documentElement.style.setProperty(
      "--popover",
      "oklch(0.9 0.02 260)",
    );
    const light = deterministicTagStyle("main");

    expect(styleVar(dark, "--tag-bg-mix")).toBe("26");
    expect(styleVar(light, "--tag-bg-mix")).toBe("18");
    expect(styleVar(dark, "--tag-border-mix")).toBe("48");
    expect(styleVar(light, "--tag-border-mix")).toBe("36");
  });

  it("falls back safely for an invalid surface color", () => {
    document.documentElement.style.setProperty("--popover", "invalid-color");
    const style = deterministicTagStyle("main");

    expect(styleVar(style, "--tag-bg-mix")).toBe("18");
    expect(styleVar(style, "--tag-border-mix")).toBe("36");
    expect(styleVar(style, "--tag-fg-mix")).toBe("52");
  });

  it("changes mix profile deterministically by selected profile", () => {
    document.documentElement.style.setProperty(
      "--popover",
      "oklch(0.22 0.02 260)",
    );

    const subtle = deterministicTagStyle("main", { profile: "subtle" });
    const vivid = deterministicTagStyle("main", { profile: "vivid" });

    expect(styleVar(subtle, "--tag-bg-mix")).toBe("20");
    expect(styleVar(vivid, "--tag-bg-mix")).toBe("33");
    expect(styleVar(subtle, "--tag-seed")).not.toBe(
      styleVar(vivid, "--tag-seed"),
    );
  });
});
