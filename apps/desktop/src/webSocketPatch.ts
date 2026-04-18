import type { contextBridge as ElectronContextBridge } from "electron";

import type { DesktopWebSocketBridge } from "./webSocketRendererBridge";

const HUBRIS_INTERNAL_HOSTS = [
  "desktop.internal.hubris.build",
  "vscode-cli.desktop.internal.hubris.build",
  "code-server.desktop.internal.hubris.build",
];

type ContextBridgeLike = Pick<
  typeof ElectronContextBridge,
  "executeInMainWorld"
>;

declare global {
  interface Window {
    __HUBRIS_ELECTRON_WS__?: DesktopWebSocketBridge;
    __HUBRIS_WS_PATCHED__?: boolean;
  }
}

/**
 * Install the websocket patch in the page world so same-origin desktop
 * WebSockets flow through Electron instead of the native browser stack.
 */
export function installDesktopWebSocketPatch(hosts: string[]): void {
  const bridge = window.__HUBRIS_ELECTRON_WS__;
  if (!bridge || typeof window.WebSocket !== "function") {
    return;
  }
  const desktopBridge = bridge;

  if (window.__HUBRIS_WS_PATCHED__) {
    return;
  }
  window.__HUBRIS_WS_PATCHED__ = true;

  const OriginalWebSocket = window.WebSocket;

  const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  };

  const fromBase64 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const shouldBridge = (url: string | URL): boolean => {
    try {
      const parsed = new URL(String(url), window.location.href);
      return (
        (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
        hosts.includes(parsed.host)
      );
    } catch {
      return false;
    }
  };

  class BridgedWebSocket extends EventTarget {
    static CONNECTING = OriginalWebSocket.CONNECTING;
    static OPEN = OriginalWebSocket.OPEN;
    static CLOSING = OriginalWebSocket.CLOSING;
    static CLOSED = OriginalWebSocket.CLOSED;

    url: string;
    readyState: number = OriginalWebSocket.CONNECTING;
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    binaryType: BinaryType = "blob";
    onopen: ((ev: Event) => unknown) | null = null;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    onerror: ((ev: Event) => unknown) | null = null;
    onclose: ((ev: CloseEvent) => unknown) | null = null;
    private socketId: string | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = new URL(String(url), window.location.href).toString();

      this.unsubscribe = desktopBridge.subscribe((event) => {
        if (!this.socketId || event.id !== this.socketId) {
          return;
        }

        if (event.type === "open") {
          this.protocol = event.protocol ?? "";
          this.readyState = OriginalWebSocket.OPEN;
          const openEvent = new Event("open");
          this.dispatchEvent(openEvent);
          this.onopen?.(openEvent);
          return;
        }

        if (event.type === "message") {
          const data = event.binary
            ? (() => {
                const bytes = fromBase64(event.data ?? "");
                const buffer = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buffer).set(bytes);
                return this.binaryType === "arraybuffer"
                  ? buffer
                  : new Blob([buffer]);
              })()
            : (event.data ?? "");
          const messageEvent = new MessageEvent("message", { data });
          this.dispatchEvent(messageEvent);
          this.onmessage?.(messageEvent);
          return;
        }

        if (event.type === "error") {
          const errorEvent = new Event("error");
          this.dispatchEvent(errorEvent);
          this.onerror?.(errorEvent);
          return;
        }

        this.readyState = OriginalWebSocket.CLOSED;
        this.unsubscribe?.();
        this.unsubscribe = null;
        const closeEvent = new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: true,
        });
        this.dispatchEvent(closeEvent);
        this.onclose?.(closeEvent);
      });

      void Promise.resolve(
        desktopBridge.connect({
          url: this.url,
          protocols:
            protocols === undefined
              ? undefined
              : Array.isArray(protocols)
                ? protocols
                : [protocols],
        }),
      )
        .then((result) => {
          this.socketId = result.id;
        })
        .catch(() => {
          this.readyState = OriginalWebSocket.CLOSED;
          this.unsubscribe?.();
          this.unsubscribe = null;
          const errorEvent = new Event("error");
          this.dispatchEvent(errorEvent);
          this.onerror?.(errorEvent);
        });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== OriginalWebSocket.OPEN || !this.socketId) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': The socket is not open.",
          "InvalidStateError",
        );
      }

      if (typeof data === "string") {
        desktopBridge.send({ id: this.socketId, data, binary: false });
        return;
      }

      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => {
          if (!this.socketId || this.readyState !== OriginalWebSocket.OPEN) {
            return;
          }
          desktopBridge.send({
            id: this.socketId,
            data: toBase64(new Uint8Array(buffer)),
            binary: true,
          });
        });
        return;
      }

      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      desktopBridge.send({
        id: this.socketId,
        data: toBase64(bytes),
        binary: true,
      });
    }

    close(code?: number, reason?: string): void {
      if (
        this.readyState === OriginalWebSocket.CLOSED ||
        this.readyState === OriginalWebSocket.CLOSING
      ) {
        return;
      }

      this.readyState = OriginalWebSocket.CLOSING;
      if (this.socketId) {
        desktopBridge.close({ id: this.socketId, code, reason });
      }
    }
  }

  const PatchedWebSocket = function WebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ) {
    if (!shouldBridge(url)) {
      return protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
    }

    return new BridgedWebSocket(url, protocols);
  } as unknown as typeof WebSocket;

  (PatchedWebSocket as { prototype: WebSocket }).prototype =
    OriginalWebSocket.prototype;
  Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
  (
    PatchedWebSocket as typeof WebSocket & {
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    }
  ).CONNECTING = OriginalWebSocket.CONNECTING;
  (
    PatchedWebSocket as typeof WebSocket & {
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    }
  ).OPEN = OriginalWebSocket.OPEN;
  (
    PatchedWebSocket as typeof WebSocket & {
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    }
  ).CLOSING = OriginalWebSocket.CLOSING;
  (
    PatchedWebSocket as typeof WebSocket & {
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    }
  ).CLOSED = OriginalWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;
}

/** Serialize the main-world websocket patch for HTML/script injection. */
export function desktopWebSocketPatchSource(): string {
  return `(${installDesktopWebSocketPatch.toString()})(${JSON.stringify(HUBRIS_INTERNAL_HOSTS)});`;
}

/** Install the websocket patch into the main world from a preload script. */
export function installDesktopWebSocketPatchInMainWorld(
  contextBridge: ContextBridgeLike,
): void {
  contextBridge.executeInMainWorld({
    func: installDesktopWebSocketPatch,
    args: [HUBRIS_INTERNAL_HOSTS],
  });
}
