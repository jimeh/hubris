import { describe, expect, it } from "vitest";
import {
  BLANK_BROWSER_URL,
  browserFrameSrc,
  browserInputValue,
  browserLabelFromUrl,
  browserPreviewProxyUrl,
  decodeBrowserPreviewProxyUrl,
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

  it("maps loopback URLs through the preview proxy and back", () => {
    const upstream = "http://localhost:3000/docs/getting-started?mode=dev";
    const proxied = browserPreviewProxyUrl(upstream);

    expect(proxied).toBe(
      "/_hubris/browser-preview/http/localhost%3A3000/docs/getting-started?mode=dev",
    );
    expect(browserFrameSrc(upstream)).toBe(proxied);
    expect(
      decodeBrowserPreviewProxyUrl(
        "http://localhost:3005/_hubris/browser-preview/http/localhost%3A3000/docs/getting-started?mode=dev",
        "http://localhost:3005",
      ),
    ).toBe(upstream);
  });
});
