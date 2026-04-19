import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDesktopRuntimeConfig } from "./desktopRuntimeConfig";
import {
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
  HUBRIS_WS_ORIGIN,
  classifyHubrisRequest,
  classifyHubrisWebSocket,
  createDesktopProtocolContext,
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
    expect(buildDesktopRuntimeConfig()).toEqual({
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

    await expect(first.text()).resolves.toBe("<html>code-server</html>");
    await expect(second.text()).resolves.toBe("<html>serve-web</html>");
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

  it("normalizes runtime-host requests that already include the runtime base path", async () => {
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
        if (
          url ===
          "http://backend.local/code/vscode-cli?folder=%2Ftmp%2Fworkspace"
        ) {
          return new Response("<html>serve-web</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        throw new Error(`unexpected fetch: ${url}`);
      });

    const response = await context.handleRequest(
      new Request(
        `${HUBRIS_VSCODE_CLI_ORIGIN}/code/vscode-cli?folder=%2Ftmp%2Fworkspace`,
      ),
    );

    await expect(response.text()).resolves.toBe("<html>serve-web</html>");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.local/code/vscode-cli?folder=%2Ftmp%2Fworkspace",
      expect.anything(),
    );
  });

  it("refreshes backend targets from the dev-state files before proxying", async () => {
    const devTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-desktop-"));

    try {
      fs.writeFileSync(
        path.join(devTmp, "dev-dev-id.backend.json"),
        '{"pid":1,"port":43123}',
      );
      fs.writeFileSync(
        path.join(devTmp, "dev-dev-id.frontend.json"),
        '{"pid":2,"port":5173}',
      );

      const cookies = {
        get: vi.fn().mockResolvedValue([]),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const context = createDesktopProtocolContext(cookies as never, {
        frontendHttpOrigin: "http://localhost:3000",
        backendHttpOrigin: "http://127.0.0.1:3001",
        backendWsOrigin: "ws://127.0.0.1:3001",
        viteWsOrigin: "ws://localhost:3000",
        devServerState: {
          devId: "dev-id",
          devTmp,
        },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          if (
            url === "http://127.0.0.1:43123/code/code-server/?folder=%2Ftmp"
          ) {
            return new Response("<html>code-server</html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }

          throw new Error(`unexpected fetch: ${url}`);
        });

      const response = await context.handleRequest(
        new Request(`${HUBRIS_CODE_SERVER_ORIGIN}/?folder=%2Ftmp`),
      );

      await expect(response.text()).resolves.toContain("code-server");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:43123/code/code-server/?folder=%2Ftmp",
        expect.anything(),
      );
    } finally {
      fs.rmSync(devTmp, { recursive: true, force: true });
    }
  });

  it("passes through proxied frontend html unchanged", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const context = createDesktopProtocolContext(cookies as never, {
      frontendHttpOrigin: "http://localhost:5173",
      backendHttpOrigin: "http://backend.local",
      backendWsOrigin: "ws://backend.local",
      viteWsOrigin: "ws://localhost:5173",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><head></head><body>frontend</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const response = await context.handleRequest(
      new Request(`${HUBRIS_ORIGIN}/`),
    );

    await expect(response.text()).resolves.toBe(
      "<html><head></head><body>frontend</body></html>",
    );
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

  it("returns a 502 response when an async proxy request rejects", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const context = createDesktopProtocolContext(cookies as never, {
      backendHttpOrigin: "http://backend.local",
      backendWsOrigin: "ws://backend.local",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    const response = await context.handleRequest(
      new Request("https://desktop.internal.hubris.build/api/projects"),
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain("boom");
  });

  it("retries proxied POST requests with a fresh request body in dev mode", async () => {
    const devTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-desktop-"));

    try {
      fs.writeFileSync(
        path.join(devTmp, "dev-dev-id.backend.json"),
        '{"pid":1,"port":43123}',
      );

      const cookies = {
        get: vi.fn().mockResolvedValue([]),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const context = createDesktopProtocolContext(cookies as never, {
        backendHttpOrigin: "http://127.0.0.1:3001",
        backendWsOrigin: "ws://127.0.0.1:3001",
        devServerState: {
          devId: "dev-id",
          devTmp,
        },
      });

      let attempts = 0;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("backend restarting");
          }

          const forwarded = new Request(
            input instanceof Request ? input : String(input),
            {
              method: init?.method,
              headers: init?.headers,
              body: init?.body as BodyInit,
              duplex: "half",
            } as RequestInit & { duplex: "half" },
          );

          expect(await forwarded.text()).toBe('{"ok":true}');
          return new Response("ok");
        });

      const response = await context.handleRequest(
        new Request("https://desktop.internal.hubris.build/api/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: '{"ok":true}',
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(devTmp, { recursive: true, force: true });
    }
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

  it("refreshes backend websocket targets from the dev-state files", async () => {
    const devTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-desktop-"));

    try {
      fs.writeFileSync(
        path.join(devTmp, "dev-dev-id.backend.json"),
        '{"pid":1,"port":43123}',
      );

      const context = createDesktopProtocolContext(
        {
          get: vi.fn().mockResolvedValue([]),
          set: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          backendHttpOrigin: "http://127.0.0.1:3001",
          backendWsOrigin: "ws://127.0.0.1:3001",
          devServerState: {
            devId: "dev-id",
            devTmp,
          },
        },
      );

      const target = await context.resolveWebSocketTarget(
        "wss://vscode-cli.desktop.internal.hubris.build/?folder=%2Ftmp",
      );

      expect(target.targetUrl).toBe(
        "ws://127.0.0.1:43123/code/vscode-cli/?folder=%2Ftmp",
      );
      expect(target.upstreamHost).toBe("127.0.0.1:43123");
    } finally {
      fs.rmSync(devTmp, { recursive: true, force: true });
    }
  });

  it("passes through packaged frontend html unchanged", async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-frontend-"));

    try {
      fs.writeFileSync(
        path.join(distDir, "index.html"),
        "<html><head></head><body>packaged</body></html>",
      );

      const context = createDesktopProtocolContext(
        {
          get: vi.fn().mockResolvedValue([]),
          set: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          frontendDistDir: distDir,
          backendHttpOrigin: "http://backend.local",
          backendWsOrigin: "ws://backend.local",
        },
      );

      const response = await context.handleRequest(
        new Request(`${HUBRIS_ORIGIN}/`),
      );

      await expect(response.text()).resolves.toBe(
        "<html><head></head><body>packaged</body></html>",
      );
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});
