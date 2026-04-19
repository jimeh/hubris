import { describe, expect, it, vi } from "vitest";

describe("preload", () => {
  it("exposes desktop bridges and installs main-world desktop bootstrap", async () => {
    vi.resetModules();

    const exposeInMainWorld = vi.fn();
    const executeInMainWorld = vi.fn();
    const invoke = vi.fn();
    const send = vi.fn();
    const on = vi.fn();

    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld,
        executeInMainWorld,
      },
      ipcRenderer: {
        invoke,
        send,
        on,
      },
    }));

    await import("./preload.js");

    expect(exposeInMainWorld).toHaveBeenCalledWith(
      "__HUBRIS_ELECTRON_WS__",
      expect.objectContaining({
        connect: expect.any(Function),
        send: expect.any(Function),
        close: expect.any(Function),
        subscribe: expect.any(Function),
      }),
    );
    expect(exposeInMainWorld).toHaveBeenCalledWith(
      "__HUBRIS_ELECTRON_BROWSER__",
      expect.objectContaining({
        create: expect.any(Function),
        destroy: expect.any(Function),
        show: expect.any(Function),
        hide: expect.any(Function),
        setBounds: expect.any(Function),
        navigate: expect.any(Function),
      }),
    );
    expect(exposeInMainWorld).toHaveBeenCalledWith(
      "__HUBRIS_ELECTRON_VSCODE__",
      expect.objectContaining({
        create: expect.any(Function),
        load: expect.any(Function),
        destroy: expect.any(Function),
        show: expect.any(Function),
        hide: expect.any(Function),
        setBounds: expect.any(Function),
      }),
    );
    expect(executeInMainWorld).toHaveBeenNthCalledWith(1, {
      func: expect.any(Function),
      args: [
        {
          apiBase: "https://desktop.internal.hubris.build/api",
          eventsUrl: "https://desktop.internal.hubris.build/api/events",
          terminalWsBase: "wss://desktop.internal.hubris.build/api/terminal/ws",
          vscodeBases: {
            codeServer: "https://code-server.desktop.internal.hubris.build/",
            vscodeCli: "https://vscode-cli.desktop.internal.hubris.build/",
          },
        },
      ],
    });
    expect(executeInMainWorld).toHaveBeenNthCalledWith(2, {
      func: expect.any(Function),
      args: [
        [
          "desktop.internal.hubris.build",
          "vscode-cli.desktop.internal.hubris.build",
          "code-server.desktop.internal.hubris.build",
        ],
      ],
    });
  });
});
