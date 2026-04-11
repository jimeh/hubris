import { describe, expect, it } from "vitest";

import {
  HUBRIS_ORIGIN,
  HUBRIS_WS_ORIGIN,
  appHtmlInjection,
  buildDesktopRuntimeConfig,
  classifyHubrisRequest,
  classifyHubrisWebSocket,
  injectHtmlScript,
  rewriteCodeServerPath,
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

describe("rewriteCodeServerPath", () => {
  it("strips the public /code prefix", () => {
    expect(rewriteCodeServerPath("/code")).toBe("/");
    expect(rewriteCodeServerPath("/code/")).toBe("/");
    expect(rewriteCodeServerPath("/code/?folder=%2Ftmp")).toBe(
      "/?folder=%2Ftmp",
    );
    expect(rewriteCodeServerPath("/code/static/out.js")).toBe("/static/out.js");
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
