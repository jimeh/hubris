export const HUBRIS_WS_CONNECT_CHANNEL = "hubris:ws-connect";
export const HUBRIS_WS_SEND_CHANNEL = "hubris:ws-send";
export const HUBRIS_WS_CLOSE_CHANNEL = "hubris:ws-close";
export const HUBRIS_WS_EVENT_CHANNEL = "hubris:ws-event";

export type WebSocketBridgeConnectRequest = {
  url: string;
  protocols?: string[];
};

export type WebSocketBridgeConnectResponse = {
  id: string;
};

export type WebSocketBridgeSendRequest = {
  id: string;
  data: string;
  binary: boolean;
};

export type WebSocketBridgeCloseRequest = {
  id: string;
  code?: number;
  reason?: string;
};

export type WebSocketBridgeEvent =
  | {
      id: string;
      type: "open";
      protocol: string;
    }
  | {
      id: string;
      type: "message";
      data: string;
      binary: boolean;
    }
  | {
      id: string;
      type: "error";
      message: string;
    }
  | {
      id: string;
      type: "close";
      code: number;
      reason: string;
    };
