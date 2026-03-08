// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getTerminalTheme } from "./xterm";

describe("getTerminalTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("reads terminal colors from CSS vars", () => {
    const style = document.documentElement.style;
    style.setProperty("--terminal-background", "#111827");
    style.setProperty("--terminal-foreground", "#e5e7eb");
    style.setProperty("--terminal-cursor", "#7c93ff");
    style.setProperty("--terminal-ansi-green", "#7eb288");

    expect(getTerminalTheme()).toMatchObject({
      background: "#111827",
      foreground: "#e5e7eb",
      cursor: "#7c93ff",
      green: "#7eb288",
    });
  });
});
