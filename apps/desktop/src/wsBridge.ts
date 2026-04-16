import { randomUUID } from "node:crypto";

import {
  ipcMain,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from "electron";
import WebSocket, { type RawData } from "ws";

import {
  HUBRIS_ORIGIN,
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
  classifyHubrisWebSocket,
  type DesktopProtocolContext,
  type DesktopProtocolTargets,
} from "./protocol";
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

type CookieStore = Pick<Session, "cookies">["cookies"];

type FrameIdentity = {
  processId?: number;
  routingId?: number;
  url?: string;
};

type FrameSender = WebContents & {
  sendToFrame?: (
    frameId: number | [number, number],
    channel: string,
    ...args: unknown[]
  ) => void;
};

type SocketRecord = {
  frame: FrameIdentity;
  sender: FrameSender;
  socket: WebSocket;
};

type ActiveBridge = {
  cookies: CookieStore;
  protocolContext: DesktopProtocolContext;
  targets: DesktopProtocolTargets;
};

const activeBridgeState: { current: ActiveBridge | null } = {
  current: null,
};
const HUBRIS_PUBLIC_HOST_HEADER = "x-hubris-public-host";
const HUBRIS_PUBLIC_ORIGIN_HEADER = "x-hubris-public-origin";

const sockets = new Map<string, SocketRecord>();
const observedWebContents = new Set<number>();
let handlersRegistered = false;

export function installWebSocketBridge(
  desktopSession: Pick<Session, "cookies">,
  protocolContext: DesktopProtocolContext,
  targets: DesktopProtocolTargets,
): void {
  activeBridgeState.current = {
    cookies: desktopSession.cookies,
    protocolContext,
    targets,
  };

  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;
  ipcMain.handle(HUBRIS_WS_CONNECT_CHANNEL, handleConnect);
  ipcMain.on(HUBRIS_WS_SEND_CHANNEL, handleSend);
  ipcMain.on(HUBRIS_WS_CLOSE_CHANNEL, handleClose);
}

async function handleConnect(
  event: IpcMainInvokeEvent,
  payload: WebSocketBridgeConnectRequest,
): Promise<WebSocketBridgeConnectResponse> {
  const activeBridge = activeBridgeState.current;
  if (!activeBridge) {
    throw new Error("desktop websocket bridge not initialized");
  }

  const frame = frameIdentityFromEvent(event);
  assertTrustedFrame(frame);
  const route = classifyHubrisWebSocket(
    payload.url,
    Boolean(activeBridge.targets.viteWsOrigin),
  );
  if (!route) {
    throw new Error(`unsupported desktop websocket URL: ${payload.url}`);
  }

  const target = await activeBridge.protocolContext.resolveWebSocketTarget(
    payload.url,
  );
  const headers: Record<string, string> = {
    origin: target.publicOrigin,
    host: target.upstreamHost,
    [HUBRIS_PUBLIC_HOST_HEADER]: new URL(target.publicOrigin).host,
    [HUBRIS_PUBLIC_ORIGIN_HEADER]: target.publicOrigin,
  };
  const cookieHeader = await cookieHeaderForUrl(
    activeBridge.cookies,
    target.cookieUrl,
  );
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  const protocols =
    payload.protocols && payload.protocols.length > 0
      ? payload.protocols
      : undefined;
  const socket = new WebSocket(target.targetUrl, protocols, {
    headers,
  });
  const id = randomUUID();
  const sender = event.sender as FrameSender;

  observeWebContents(sender);
  sockets.set(id, { frame, sender, socket });

  socket.on("open", () => {
    sendFrameEvent(sender, frame, {
      id,
      type: "open",
      protocol: socket.protocol,
    });
  });
  socket.on("message", (data: RawData, isBinary: boolean) => {
    const serialized = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    sendFrameEvent(sender, frame, {
      id,
      type: "message",
      data: isBinary
        ? serialized.toString("base64")
        : serialized.toString("utf8"),
      binary: isBinary,
    });
  });
  socket.on("error", (error: Error) => {
    sendFrameEvent(sender, frame, {
      id,
      type: "error",
      message: error.message,
    });
  });
  socket.on("close", (code: number, reason: Buffer) => {
    sockets.delete(id);
    sendFrameEvent(sender, frame, {
      id,
      type: "close",
      code,
      reason: reason.toString(),
    });
  });

  return { id };
}

function handleSend(
  event: IpcMainEvent,
  payload: WebSocketBridgeSendRequest,
): void {
  const frame = frameIdentityFromEvent(event);
  const record = sockets.get(payload.id);
  if (!record || !sameFrame(record.frame, frame)) {
    return;
  }

  const body = payload.binary
    ? Buffer.from(payload.data, "base64")
    : payload.data;
  record.socket.send(body);
}

function handleClose(
  event: IpcMainEvent,
  payload: WebSocketBridgeCloseRequest,
): void {
  const frame = frameIdentityFromEvent(event);
  const record = sockets.get(payload.id);
  if (!record || !sameFrame(record.frame, frame)) {
    return;
  }

  record.socket.close(payload.code, payload.reason);
}

function observeWebContents(webContents: FrameSender): void {
  if (observedWebContents.has(webContents.id)) {
    return;
  }

  observedWebContents.add(webContents.id);
  webContents.once("destroyed", () => {
    observedWebContents.delete(webContents.id);
    closeSocketsForWebContents(webContents.id);
  });
  webContents.on("render-process-gone", () => {
    closeSocketsForWebContents(webContents.id);
  });
}

function closeSocketsForWebContents(webContentsId: number): void {
  for (const [id, record] of sockets) {
    if (record.sender.id !== webContentsId) {
      continue;
    }

    sockets.delete(id);
    record.socket.close();
  }
}

function frameIdentityFromEvent(
  event: IpcMainInvokeEvent | IpcMainEvent,
): FrameIdentity {
  const senderFrame = (
    event as IpcMainInvokeEvent & {
      senderFrame?: {
        processId?: number;
        routingId?: number;
        url?: string;
      };
    }
  ).senderFrame;

  return {
    processId: senderFrame?.processId,
    routingId: senderFrame?.routingId,
    url: senderFrame?.url,
  };
}

function assertTrustedFrame(frame: FrameIdentity): void {
  const url = frame.url;
  if (!url) {
    throw new Error("missing sender frame URL");
  }

  const parsed = new URL(url);
  if (
    parsed.origin !== HUBRIS_ORIGIN &&
    parsed.origin !== HUBRIS_VSCODE_CLI_ORIGIN &&
    parsed.origin !== HUBRIS_CODE_SERVER_ORIGIN
  ) {
    throw new Error(`untrusted websocket bridge caller: ${url}`);
  }
}

function sameFrame(left: FrameIdentity, right: FrameIdentity): boolean {
  return (
    left.processId === right.processId && left.routingId === right.routingId
  );
}

function sendFrameEvent(
  sender: FrameSender,
  frame: FrameIdentity,
  payload: WebSocketBridgeEvent,
): void {
  if (sender.isDestroyed()) {
    return;
  }

  try {
    if (
      typeof sender.sendToFrame === "function" &&
      frame.routingId !== undefined &&
      frame.processId !== undefined
    ) {
      sender.sendToFrame(
        [frame.processId, frame.routingId],
        HUBRIS_WS_EVENT_CHANNEL,
        payload,
      );
      return;
    }

    sender.send(HUBRIS_WS_EVENT_CHANNEL, payload);
  } catch {
    // The target frame may have gone away after the socket event fired.
  }
}

async function cookieHeaderForUrl(
  cookies: CookieStore,
  url: string,
): Promise<string> {
  const cookieUrl = new URL(url);
  if (cookieUrl.protocol === "ws:") {
    cookieUrl.protocol = "http:";
  } else if (cookieUrl.protocol === "wss:") {
    cookieUrl.protocol = "https:";
  }

  const cookieList = await cookies.get({ url: cookieUrl.toString() });
  return cookieList
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
