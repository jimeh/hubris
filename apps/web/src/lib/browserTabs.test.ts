import { describe, expect, it } from "vitest";
import {
  BLANK_BROWSER_URL,
  browserInputValue,
  browserLabelFromUrl,
  normalizeBrowserUrl,
  parseBrowserUrlInput,
} from "./browserTabs";

describe("browserTabs helpers", () => {
  it("accepts bare host input without collapsing it early", () => {
    expect(parseBrowserUrlInput("github.com/docs")).toEqual({
      kind: "scheme-unspecified",
      raw: "github.com/docs",
      httpUrl: "http://github.com/docs",
      httpsUrl: "https://github.com/docs",
    });
  });

  it("normalizes about:blank only when explicitly allowed", () => {
    expect(normalizeBrowserUrl(BLANK_BROWSER_URL, { allowBlank: true })).toBe(
      BLANK_BROWSER_URL,
    );
    expect(browserInputValue(BLANK_BROWSER_URL)).toBe("");
    expect(browserLabelFromUrl(BLANK_BROWSER_URL)).toBe("New Browser");
  });

  it("keeps direct iframe URLs for localhost previews and external pages", () => {
    expect(normalizeBrowserUrl("localhost:3000/docs")).toBe(
      "http://localhost:3000/docs",
    );
    expect(normalizeBrowserUrl("https://github.com/openai")).toBe(
      "https://github.com/openai",
    );
  });
});
