import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
  HUBRIS_WS_ORIGIN,
  appHtmlInjection,
  buildDesktopRuntimeConfig,
  classifyHubrisRequest,
  classifyHubrisWebSocket,
  createDesktopProtocolContext,
  injectHtmlScript,
} from "./protocol";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("routes runtime-host paths to the direct code proxy", () => {
    expect(
      classifyHubrisRequest(`${HUBRIS_CODE_SERVER_ORIGIN}/?folder=/tmp`),
    ).toBe("code");
    expect(
      classifyHubrisRequest(`${HUBRIS_VSCODE_CLI_ORIGIN}/?folder=/tmp`),
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
        "wss://code-server.desktop.internal.hubris.build/static/out/vs/base/worker",
        false,
      ),
    ).toBe("code");
    expect(
      classifyHubrisWebSocket(
        "wss://vscode-cli.desktop.internal.hubris.build/static/out/vs/base/worker",
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

describe("buildDesktopRuntimeConfig", () => {
  it("emits stable desktop URLs", () => {
    expect(JSON.parse(buildDesktopRuntimeConfig())).toEqual({
      apiBase: `${HUBRIS_ORIGIN}/api`,
      eventsUrl: `${HUBRIS_ORIGIN}/api/events`,
      terminalWsBase: `${HUBRIS_WS_ORIGIN}/api/terminal/ws`,
      vscodeBases: {
        codeServer: `${HUBRIS_CODE_SERVER_ORIGIN}/`,
        vscodeCli: `${HUBRIS_VSCODE_CLI_ORIGIN}/`,
      },
    });
  });
});

describe("createDesktopProtocolContext", () => {
  it("refreshes each runtime upstream on top-level runtime navigations", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const context = createDesktopProtocolContext(cookies as never, {
      backendHttpOrigin: "http://backend.local",
      backendWsOrigin: "ws://backend.local",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "http://backend.local/code/code-server/?folder=%2Ftmp") {
          return new Response("<html>code-server</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        if (url === "http://backend.local/code/vscode-cli/?folder=%2Ftmp") {
          return new Response("<html>serve-web</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        throw new Error(`unexpected fetch: ${url}`);
      });

    const first = await context.handleRequest(
      new Request(`${HUBRIS_CODE_SERVER_ORIGIN}/?folder=%2Ftmp`),
    );
    const second = await context.handleRequest(
      new Request(`${HUBRIS_VSCODE_CLI_ORIGIN}/?folder=%2Ftmp`),
    );

    await expect(first.text()).resolves.toContain("code-server");
    await expect(second.text()).resolves.toContain("serve-web");
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          (input instanceof Request ? input.url : String(input)) ===
          "http://backend.local/code/code-server/?folder=%2Ftmp",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          (input instanceof Request ? input.url : String(input)) ===
          "http://backend.local/code/vscode-cli/?folder=%2Ftmp",
      ),
    ).toHaveLength(1);
  });

  it("preserves the public runtime host when proxying runtime HTTP", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const context = createDesktopProtocolContext(cookies as never, {
      backendHttpOrigin: "http://backend.local",
      backendWsOrigin: "ws://backend.local",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "http://backend.local/code/code-server/?folder=%2Ftmp") {
          expect(new Headers(init?.headers).get("x-hubris-public-host")).toBe(
            "code-server.desktop.internal.hubris.build",
          );
          expect(new Headers(init?.headers).get("x-hubris-public-origin")).toBe(
            HUBRIS_CODE_SERVER_ORIGIN,
          );
          return new Response("ok");
        }

        if (url === "http://backend.local/code/vscode-cli/?folder=%2Ftmp") {
          expect(new Headers(init?.headers).get("x-hubris-public-host")).toBe(
            "vscode-cli.desktop.internal.hubris.build",
          );
          expect(new Headers(init?.headers).get("x-hubris-public-origin")).toBe(
            HUBRIS_VSCODE_CLI_ORIGIN,
          );
          return new Response("ok");
        }

        throw new Error(`unexpected fetch: ${url}`);
      });

    await context.handleRequest(
      new Request(`${HUBRIS_CODE_SERVER_ORIGIN}/?folder=%2Ftmp`),
    );
    await context.handleRequest(
      new Request(`${HUBRIS_VSCODE_CLI_ORIGIN}/?folder=%2Ftmp`),
    );

    expect(fetchMock).toHaveBeenCalled();
  });

  it("resolves runtime websocket targets onto the runtime upstream path", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const context = createDesktopProtocolContext(cookies as never, {
      backendHttpOrigin: "http://backend.local",
      backendWsOrigin: "ws://backend.local",
    });
    const target = await context.resolveWebSocketTarget(
      "wss://vscode-cli.desktop.internal.hubris.build/?folder=%2Ftmp",
    );

    expect(target).toEqual({
      cookieUrl:
        "wss://vscode-cli.desktop.internal.hubris.build/?folder=%2Ftmp",
      publicOrigin: HUBRIS_VSCODE_CLI_ORIGIN,
      targetUrl: "ws://backend.local/code/vscode-cli/?folder=%2Ftmp",
      upstreamHost: "backend.local",
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
