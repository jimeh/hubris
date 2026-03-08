import { describe, expect, it } from "vitest";
import source from "./AppearanceSettings.tsx?raw";

describe("AppearanceSettings", () => {
  it("does not include the legacy theme manager UI", () => {
    expect(source).not.toContain("ThemeManager");
    expect(source).not.toContain("Manage Themes");
    expect(source).not.toContain("Import VS Code Theme");
  });
});
