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

export type BridgeListener = (event: WebSocketBridgeEvent) => void;

export type DesktopWebSocketBridge = {
  connect(
    payload: WebSocketBridgeConnectRequest,
  ): Promise<WebSocketBridgeConnectResponse>;
  send(payload: WebSocketBridgeSendRequest): void;
  close(payload: WebSocketBridgeCloseRequest): void;
  subscribe(listener: BridgeListener): () => void;
};

type IpcRendererLike = Pick<
  typeof import("electron").ipcRenderer,
  "invoke" | "send" | "on"
>;

/** Build the renderer-side wrapper around the desktop websocket IPC bridge. */
export function createDesktopWebSocketBridge(
  ipcRenderer: IpcRendererLike,
): DesktopWebSocketBridge {
  const listeners = new Set<BridgeListener>();

  ipcRenderer.on(
    HUBRIS_WS_EVENT_CHANNEL,
    (_event, payload: WebSocketBridgeEvent) => {
      for (const listener of listeners) {
        listener(payload);
      }
    },
  );

  return {
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
}
