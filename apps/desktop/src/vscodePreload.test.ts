import { describe, expect, it, vi } from "vitest";

describe("vscodePreload", () => {
  it("exposes the websocket bridge and installs the main-world patch", async () => {
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

    await import("./vscodePreload.js");

    expect(exposeInMainWorld).toHaveBeenCalledWith(
      "__HUBRIS_ELECTRON_WS__",
      expect.objectContaining({
        connect: expect.any(Function),
        send: expect.any(Function),
        close: expect.any(Function),
        subscribe: expect.any(Function),
      }),
    );
    expect(executeInMainWorld).toHaveBeenCalledWith({
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
