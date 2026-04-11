import { describe, expect, it } from "vitest";

import {
  HUBRIS_ORIGIN,
  HUBRIS_WS_ORIGIN,
  appHtmlInjection,
  authorizedVscodePath,
  buildDesktopRuntimeConfig,
  classifyHubrisRequest,
  classifyHubrisWebSocket,
  injectHtmlScript,
  rewriteVscodePath,
} from "./protocol";

describe("classifyHubrisRequest", () => {
  it("routes backend paths to the backend proxy", () => {
    expect(
      classifyHubrisRequest(
        "https://desktop.internal.hubris.build/api/projects",
      ),
    ).toBe("backend");
    expect(
      classifyHubrisRequest(
        "https://desktop.internal.hubris.build/_hubris/desktop/bootstrap",
      ),
    ).toBe("backend");
  });

  it("routes code-server paths to the direct code proxy", () => {
    expect(
      classifyHubrisRequest(
        "https://desktop.internal.hubris.build/code/?folder=/tmp",
      ),
    ).toBe("code");
  });

  it("routes other paths to the frontend", () => {
    expect(
      classifyHubrisRequest("https://desktop.internal.hubris.build/"),
    ).toBe("frontend");
    expect(
      classifyHubrisRequest(
        "https://desktop.internal.hubris.build/src/main.tsx",
      ),
    ).toBe("frontend");
  });
});

describe("classifyHubrisWebSocket", () => {
  it("routes terminal sockets to the backend websocket target", () => {
    expect(
      classifyHubrisWebSocket(
        "wss://desktop.internal.hubris.build/api/terminal/ws?tab_id=1",
        false,
      ),
    ).toBe("backend");
  });

  it("routes code-server sockets to the direct code-server target", () => {
    expect(
      classifyHubrisWebSocket(
        "wss://desktop.internal.hubris.build/code/static/out/vs/base/worker",
        false,
      ),
    ).toBe("code");
  });

  it("routes other same-origin dev sockets to Vite when present", () => {
    expect(
      classifyHubrisWebSocket(
        "wss://desktop.internal.hubris.build/@vite/client",
        true,
      ),
    ).toBe("vite");
  });
});

describe("rewriteVscodePath", () => {
  it("strips the public /code prefix for code-server", () => {
    expect(rewriteVscodePath("/code", "stripPublicBasePath")).toBe("/");
    expect(rewriteVscodePath("/code/", "stripPublicBasePath")).toBe("/");
    expect(
      rewriteVscodePath("/code/?folder=%2Ftmp", "stripPublicBasePath"),
    ).toBe("/?folder=%2Ftmp");
    expect(
      rewriteVscodePath("/code/static/out.js", "stripPublicBasePath"),
    ).toBe("/static/out.js");
  });

  it("preserves the public /code prefix for serve-web", () => {
    expect(rewriteVscodePath("/code", "preservePublicBasePath")).toBe("/code");
    expect(
      rewriteVscodePath("/code/static/out.js", "preservePublicBasePath"),
    ).toBe("/code/static/out.js");
  });
});

describe("authorizedVscodePath", () => {
  const vscodeCliConnection = {
    runtime: "vscodeCli" as const,
    baseUrl: "http://127.0.0.1:1234",
    wsBaseUrl: "ws://127.0.0.1:1234",
    pathMode: "preservePublicBasePath" as const,
    connectionToken: "fresh-token",
  };

  it("adds the current token when the cookie is missing", () => {
    expect(
      authorizedVscodePath("/code?folder=%2Ftmp", vscodeCliConnection, null),
    ).toBe("/code?folder=%2Ftmp&tkn=fresh-token");
  });

  it("replaces stale query auth when the cookie is stale", () => {
    expect(
      authorizedVscodePath(
        "/code?folder=%2Ftmp&tkn=stale-query",
        vscodeCliConnection,
        "vscode-tkn=stale-cookie; theme=dark",
      ),
    ).toBe("/code?folder=%2Ftmp&tkn=fresh-token");
  });

  it("preserves a matching current cookie without appending a query token", () => {
    expect(
      authorizedVscodePath(
        "/code?folder=%2Ftmp",
        vscodeCliConnection,
        "vscode-tkn=fresh-token; theme=dark",
      ),
    ).toBe("/code?folder=%2Ftmp");
  });
});

describe("buildDesktopRuntimeConfig", () => {
  it("emits stable desktop URLs", () => {
    expect(JSON.parse(buildDesktopRuntimeConfig())).toEqual({
      apiBase: `${HUBRIS_ORIGIN}/api`,
      eventsUrl: `${HUBRIS_ORIGIN}/api/events`,
      terminalWsBase: `${HUBRIS_WS_ORIGIN}/api/terminal/ws`,
      codeBase: `${HUBRIS_ORIGIN}/code/`,
    });
  });
});

describe("injectHtmlScript", () => {
  it("injects into the head when present", () => {
    expect(
      injectHtmlScript(
        "<html><head><title>x</title></head><body></body></html>",
        "<script>test()</script>",
      ),
    ).toContain("<script>test()</script></head>");
  });
});

describe("appHtmlInjection", () => {
  it("includes desktop runtime config in app html", () => {
    expect(appHtmlInjection()).toContain("__HUBRIS_DESKTOP_CONFIG__");
  });
});
