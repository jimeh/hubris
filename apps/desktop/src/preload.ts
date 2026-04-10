import { contextBridge, ipcRenderer } from "electron";

import {
  HUBRIS_WS_CLOSE_CHANNEL,
  HUBRIS_WS_CONNECT_CHANNEL,
  HUBRIS_WS_EVENT_CHANNEL,
  HUBRIS_WS_SEND_CHANNEL,
  type WebSocketBridgeCloseRequest,
  type WebSocketBridgeConnectRequest,
  type WebSocketBridgeConnectResponse,
  type WebSocketBridgeEvent,
  type WebSocketBridgeSendRequest,
} from "./wsBridgeShared";

type BridgeListener = (event: WebSocketBridgeEvent) => void;

type DesktopWebSocketBridge = {
  connect(
    payload: WebSocketBridgeConnectRequest,
  ): Promise<WebSocketBridgeConnectResponse>;
  send(payload: WebSocketBridgeSendRequest): void;
  close(payload: WebSocketBridgeCloseRequest): void;
  subscribe(listener: BridgeListener): () => void;
};

declare global {
  interface Window {
    __HUBRIS_ELECTRON_WS__?: DesktopWebSocketBridge;
  }
}

const listeners = new Set<BridgeListener>();

const bridge: DesktopWebSocketBridge = {
  connect(payload) {
    return ipcRenderer.invoke(HUBRIS_WS_CONNECT_CHANNEL, payload);
  },
  send(payload) {
    ipcRenderer.send(HUBRIS_WS_SEND_CHANNEL, payload);
  },
  close(payload) {
    ipcRenderer.send(HUBRIS_WS_CLOSE_CHANNEL, payload);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

ipcRenderer.on(
  HUBRIS_WS_EVENT_CHANNEL,
  (_event, payload: WebSocketBridgeEvent) => {
    for (const listener of listeners) {
      listener(payload);
    }
  },
);

contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_WS__", bridge);
installDesktopWebSocketShim(bridge);

function installDesktopWebSocketShim(
  desktopBridge: DesktopWebSocketBridge,
): void {
  const OriginalWebSocket = window.WebSocket;

  class BridgedWebSocket extends EventTarget {
    static readonly CONNECTING: number = OriginalWebSocket.CONNECTING;
    static readonly OPEN: number = OriginalWebSocket.OPEN;
    static readonly CLOSING: number = OriginalWebSocket.CLOSING;
    static readonly CLOSED: number = OriginalWebSocket.CLOSED;

    readonly CONNECTING: number = OriginalWebSocket.CONNECTING;
    readonly OPEN: number = OriginalWebSocket.OPEN;
    readonly CLOSING: number = OriginalWebSocket.CLOSING;
    readonly CLOSED: number = OriginalWebSocket.CLOSED;

    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    readyState: number = OriginalWebSocket.CONNECTING;
    readonly url: string;

    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;

    #socketId: string | null = null;
    #unsubscribe: (() => void) | null = null;
    #pendingClose: WebSocketBridgeCloseRequest | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();

      this.url = new URL(String(url), window.location.href).toString();
      this.#unsubscribe = desktopBridge.subscribe((event) => {
        if (!this.#socketId || event.id !== this.#socketId) {
          return;
        }

        this.#handleBridgeEvent(event);
      });

      void desktopBridge
        .connect({
          url: this.url,
          protocols: normalizeProtocols(protocols),
        })
        .then(({ id }) => {
          this.#socketId = id;
          if (this.#pendingClose) {
            this.readyState = OriginalWebSocket.CLOSING;
            desktopBridge.close({
              ...this.#pendingClose,
              id,
            });
          }
        })
        .catch((error) => {
          this.#fail(error instanceof Error ? error.message : String(error));
        });
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === OriginalWebSocket.CLOSING) {
        return;
      }

      if (this.readyState === OriginalWebSocket.CLOSED) {
        return;
      }

      if (!this.#socketId) {
        this.readyState = OriginalWebSocket.CLOSING;
        this.#pendingClose = {
          id: "",
          ...(code !== undefined ? { code } : {}),
          ...(reason !== undefined ? { reason } : {}),
        };
        return;
      }

      this.readyState = OriginalWebSocket.CLOSING;
      desktopBridge.close({
        id: this.#socketId,
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== OriginalWebSocket.OPEN || !this.#socketId) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': The socket is not open.",
          "InvalidStateError",
        );
      }

      if (typeof data === "string") {
        desktopBridge.send({
          id: this.#socketId,
          data,
          binary: false,
        });
        return;
      }

      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => {
          if (!this.#socketId || this.readyState !== OriginalWebSocket.OPEN) {
            return;
          }

          desktopBridge.send({
            id: this.#socketId,
            data: Buffer.from(buffer).toString("base64"),
            binary: true,
          });
        });
        return;
      }

      const bytes = ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
      desktopBridge.send({
        id: this.#socketId,
        data: bytes.toString("base64"),
        binary: true,
      });
    }

    #handleBridgeEvent(event: WebSocketBridgeEvent): void {
      switch (event.type) {
        case "open":
          this.protocol = event.protocol;
          this.readyState = OriginalWebSocket.OPEN;
          this.#emit(new Event("open"), this.onopen);
          break;
        case "message":
          this.#emit(
            new MessageEvent("message", {
              data: event.binary ? this.#decodeBinary(event.data) : event.data,
            }),
            this.onmessage,
          );
          break;
        case "error":
          this.#emit(new Event("error"), this.onerror);
          break;
        case "close":
          this.readyState = OriginalWebSocket.CLOSED;
          this.#cleanup();
          this.#emit(
            new CloseEvent("close", {
              code: event.code,
              reason: event.reason,
              wasClean: true,
            }),
            this.onclose,
          );
          break;
      }
    }

    #decodeBinary(data: string): ArrayBuffer | Blob {
      const bytes = Buffer.from(data, "base64");
      if (this.binaryType === "arraybuffer") {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      }

      return new Blob([bytes]);
    }

    #emit<T extends Event>(
      event: T,
      handler: ((this: WebSocket, ev: T) => unknown) | null,
    ): void {
      this.dispatchEvent(event);
      handler?.call(this as unknown as WebSocket, event);
    }

    #fail(message: string): void {
      this.readyState = OriginalWebSocket.CLOSED;
      this.#cleanup();
      this.#emit(new Event("error"), this.onerror);
      this.#emit(
        new CloseEvent("close", {
          code: 1011,
          reason: message,
          wasClean: false,
        }),
        this.onclose,
      );
    }

    #cleanup(): void {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    }
  }

  const HubrisWebSocket = function WebSocket(
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const normalized = new URL(String(url), window.location.href);
    if (!shouldBridgeWebSocket(normalized, window.location.href)) {
      return protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
    }

    return new BridgedWebSocket(
      normalized.toString(),
      protocols,
    ) as unknown as WebSocket;
  } as unknown as typeof WebSocket;

  const MutableHubrisWebSocket = HubrisWebSocket as typeof WebSocket & {
    CONNECTING: number;
    OPEN: number;
    CLOSING: number;
    CLOSED: number;
  };

  MutableHubrisWebSocket.prototype = OriginalWebSocket.prototype;
  Object.setPrototypeOf(MutableHubrisWebSocket, OriginalWebSocket);
  MutableHubrisWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  MutableHubrisWebSocket.OPEN = OriginalWebSocket.OPEN;
  MutableHubrisWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  MutableHubrisWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    writable: true,
    value: MutableHubrisWebSocket,
  });
}

function shouldBridgeWebSocket(url: URL, currentLocation: string): boolean {
  const current = new URL(currentLocation);
  return (
    (url.protocol === "ws:" || url.protocol === "wss:") &&
    url.host === current.host
  );
}

function normalizeProtocols(
  protocols?: string | string[],
): string[] | undefined {
  if (!protocols) {
    return undefined;
  }

  return Array.isArray(protocols) ? protocols : [protocols];
}
