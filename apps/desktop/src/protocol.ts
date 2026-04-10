import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { Session } from "electron";

const require = createRequire(__filename);

const CODE_SERVER_CONNECTION_PATH = "/_hubris/code-server/connection";
const DESKTOP_WS_BRIDGE_SCRIPT_PATH = "/_hubris/desktop/ws-bridge.js";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const HUBRIS_SCHEME = "https";
export const HUBRIS_HOST = "desktop.internal.hubris.build";
export const HUBRIS_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_HOST}`;
export const HUBRIS_WS_ORIGIN = `wss://${HUBRIS_HOST}`;

export type DesktopProtocolTargets = {
  frontendDistDir?: string;
  frontendHttpOrigin?: string;
  backendHttpOrigin: string;
  backendWsOrigin: string;
  viteWsOrigin?: string;
};

export type HubrisRouteKind = "frontend" | "backend" | "code";
export type HubrisWebSocketRouteKind = "backend" | "code" | "vite";

export type DesktopProtocolContext = {
  handleRequest(request: Request): Promise<Response>;
  resolveWebSocketTarget(url: string): Promise<string>;
};

type CookieStore = Pick<Session, "cookies">["cookies"];

type CodeServerConnectionInfo = {
  baseUrl: string;
  wsBaseUrl: string;
};

type ProtocolState = {
  codeServerConnection?: CodeServerConnectionInfo;
  codeServerConnectionPromise?: Promise<CodeServerConnectionInfo>;
};

type ParsedSetCookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
};

type ProxyRequestOptions = {
  targetUrl: string;
  hostUrl?: string;
  cookies?: CookieStore;
  cookieUrl?: string;
  stripOrigin?: boolean;
};

export function registerHubrisScheme(): void {
  // No-op: the desktop app uses a handled HTTPS host.
}

export function classifyHubrisRequest(url: string): HubrisRouteKind {
  const parsed = new URL(url);
  if (!isHubrisHttpUrl(parsed)) {
    return "frontend";
  }

  const pathname = parsed.pathname;
  if (pathname === DESKTOP_WS_BRIDGE_SCRIPT_PATH) {
    return "frontend";
  }
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/_hubris" ||
    pathname.startsWith("/_hubris/")
  ) {
    return "backend";
  }

  if (pathname === "/code" || pathname.startsWith("/code/")) {
    return "code";
  }

  return "frontend";
}

export function classifyHubrisWebSocket(
  url: string,
  hasViteTarget: boolean,
): HubrisWebSocketRouteKind | null {
  const parsed = new URL(url, HUBRIS_ORIGIN);
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.host !== HUBRIS_HOST
  ) {
    return null;
  }

  const pathname = parsed.pathname;
  if (pathname === "/code" || pathname.startsWith("/code/")) {
    return "code";
  }

  if (
    pathname === "/api/terminal/ws" ||
    pathname.startsWith("/api/terminal/ws/")
  ) {
    return "backend";
  }

  if (hasViteTarget) {
    return "vite";
  }

  return null;
}

export function rewriteCodeServerPath(pathAndQuery: string): string {
  const stripped = pathAndQuery.replace(/^\/code/, "");
  if (stripped === "") {
    return "/";
  }

  if (stripped.startsWith("/") || stripped.startsWith("?")) {
    return `/${stripped.replace(/^\/+/, "")}`;
  }

  return `/${stripped}`;
}

export async function registerHubrisProtocol(
  desktopSession: Pick<Session, "protocol" | "cookies">,
  targets: DesktopProtocolTargets,
): Promise<DesktopProtocolContext> {
  const context = createDesktopProtocolContext(desktopSession.cookies, targets);
  const existing = desktopSession.protocol.isProtocolHandled("https");
  if (await existing) {
    await desktopSession.protocol.unhandle("https");
  }

  await desktopSession.protocol.handle("https", async (request) => {
    const requestUrl = new URL(request.url);
    if (!isHubrisHttpUrl(requestUrl)) {
      const { net } = require("electron") as typeof import("electron");
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }

    return context.handleRequest(request);
  });

  return context;
}

export function createDesktopProtocolContext(
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
): DesktopProtocolContext {
  const state: ProtocolState = {};

  return {
    handleRequest(request: Request) {
      return handleHubrisProtocolRequest(request, cookies, targets, state);
    },
    resolveWebSocketTarget(url: string) {
      return resolveHubrisWebSocketTarget(url, cookies, targets, state);
    },
  };
}

export function buildDesktopRuntimeConfig(): string {
  return JSON.stringify({
    apiBase: `${HUBRIS_ORIGIN}/api`,
    eventsUrl: `${HUBRIS_ORIGIN}/api/events`,
    terminalWsBase: `${HUBRIS_WS_ORIGIN}/api/terminal/ws`,
    codeBase: `${HUBRIS_ORIGIN}/code/`,
  });
}

export function appHtmlInjection(): string {
  return [
    "<script>",
    `window.__HUBRIS_DESKTOP_CONFIG__ = ${buildDesktopRuntimeConfig()};`,
    "</script>",
    webSocketBridgeInjection(),
  ].join("");
}

export function codeServerHtmlInjection(): string {
  return `<script src="${DESKTOP_WS_BRIDGE_SCRIPT_PATH}"></script>`;
}

function webSocketBridgeInjection(): string {
  return ["<script>", webSocketBridgeScript(), "</script>"].join("");
}

function webSocketBridgeScript(): string {
  return [
    "(function () {",
    "  var bridge = window.__HUBRIS_ELECTRON_WS__ || (window.top && window.top.__HUBRIS_ELECTRON_WS__);",
    "  if (!bridge || typeof window.WebSocket !== 'function') return;",
    "  var OriginalWebSocket = window.WebSocket;",
    "  function toBase64(bytes) {",
    "    var binary = '';",
    "    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);",
    "    return btoa(binary);",
    "  }",
    "  function fromBase64(base64) {",
    "    var binary = atob(base64);",
    "    var bytes = new Uint8Array(binary.length);",
    "    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);",
    "    return bytes;",
    "  }",
    "  function shouldBridge(url) {",
    "    try {",
    "      var parsed = new URL(String(url), window.location.href);",
    `      return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.host === ${JSON.stringify(HUBRIS_HOST)};`,
    "    } catch (_error) {",
    "      return false;",
    "    }",
    "  }",
    "  class BridgedWebSocket extends EventTarget {",
    "    static CONNECTING = OriginalWebSocket.CONNECTING;",
    "    static OPEN = OriginalWebSocket.OPEN;",
    "    static CLOSING = OriginalWebSocket.CLOSING;",
    "    static CLOSED = OriginalWebSocket.CLOSED;",
    "    constructor(url, protocols) {",
    "      super();",
    "      this.url = new URL(String(url), window.location.href).toString();",
    "      this.readyState = OriginalWebSocket.CONNECTING;",
    "      this.bufferedAmount = 0;",
    "      this.extensions = '';",
    "      this.protocol = '';",
    "      this.binaryType = 'blob';",
    "      this.onopen = null;",
    "      this.onmessage = null;",
    "      this.onerror = null;",
    "      this.onclose = null;",
    "      this._socketId = null;",
    "      this._unsubscribe = bridge.subscribe((event) => {",
    "        if (!this._socketId || event.id !== this._socketId) return;",
    "        if (event.type === 'open') {",
    "          this.protocol = event.protocol || '';",
    "          this.readyState = OriginalWebSocket.OPEN;",
    "          var openEvent = new Event('open');",
    "          this.dispatchEvent(openEvent);",
    "          if (typeof this.onopen === 'function') this.onopen.call(this, openEvent);",
    "          return;",
    "        }",
    "        if (event.type === 'message') {",
    "          var data;",
    "          if (event.binary) {",
    "            var bytes = fromBase64(event.data);",
    "            data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);",
    "          } else {",
    "            data = event.data;",
    "          }",
    "          var messageEvent = new MessageEvent('message', { data: data });",
    "          this.dispatchEvent(messageEvent);",
    "          if (typeof this.onmessage === 'function') this.onmessage.call(this, messageEvent);",
    "          return;",
    "        }",
    "        if (event.type === 'error') {",
    "          var errorEvent = new Event('error');",
    "          this.dispatchEvent(errorEvent);",
    "          if (typeof this.onerror === 'function') this.onerror.call(this, errorEvent);",
    "          return;",
    "        }",
    "        if (event.type === 'close') {",
    "          this.readyState = OriginalWebSocket.CLOSED;",
    "          if (this._unsubscribe) this._unsubscribe();",
    "          this._unsubscribe = null;",
    "          var closeEvent = new CloseEvent('close', { code: event.code, reason: event.reason, wasClean: true });",
    "          this.dispatchEvent(closeEvent);",
    "          if (typeof this.onclose === 'function') this.onclose.call(this, closeEvent);",
    "        }",
    "      });",
    "      Promise.resolve(bridge.connect({",
    "        url: this.url,",
    "        protocols: protocols === undefined ? undefined : (Array.isArray(protocols) ? protocols : [protocols]),",
    "      })).then((result) => {",
    "        this._socketId = result.id;",
    "      }).catch(() => {",
    "        this.readyState = OriginalWebSocket.CLOSED;",
    "        if (this._unsubscribe) this._unsubscribe();",
    "        this._unsubscribe = null;",
    "        var errorEvent = new Event('error');",
    "        this.dispatchEvent(errorEvent);",
    "        if (typeof this.onerror === 'function') this.onerror.call(this, errorEvent);",
    "      });",
    "    }",
    "    send(data) {",
    "      if (this.readyState !== OriginalWebSocket.OPEN || !this._socketId) {",
    "        throw new DOMException(\"Failed to execute 'send' on 'WebSocket': The socket is not open.\", 'InvalidStateError');",
    "      }",
    "      if (typeof data === 'string') {",
    "        bridge.send({ id: this._socketId, data: data, binary: false });",
    "        return;",
    "      }",
    "      if (data instanceof Blob) {",
    "        data.arrayBuffer().then((buffer) => {",
    "          if (!this._socketId || this.readyState !== OriginalWebSocket.OPEN) return;",
    "          bridge.send({ id: this._socketId, data: toBase64(new Uint8Array(buffer)), binary: true });",
    "        });",
    "        return;",
    "      }",
    "      var bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);",
    "      bridge.send({ id: this._socketId, data: toBase64(bytes), binary: true });",
    "    }",
    "    close(code, reason) {",
    "      if (this.readyState === OriginalWebSocket.CLOSED || this.readyState === OriginalWebSocket.CLOSING) return;",
    "      this.readyState = OriginalWebSocket.CLOSING;",
    "      if (this._socketId) bridge.close({ id: this._socketId, code: code, reason: reason });",
    "    }",
    "  }",
    "  window.WebSocket = function WebSocket(url, protocols) {",
    "    if (!shouldBridge(url)) {",
    "      return protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);",
    "    }",
    "    return new BridgedWebSocket(url, protocols);",
    "  };",
    "  window.WebSocket.prototype = OriginalWebSocket.prototype;",
    "  Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);",
    "  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;",
    "  window.WebSocket.OPEN = OriginalWebSocket.OPEN;",
    "  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;",
    "  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;",
    "})();",
  ].join("");
}

export function injectHtmlScript(html: string, script: string): string {
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }

  if (html.includes("<body")) {
    return html.replace(/(<body[^>]*>)/i, `$1${script}`);
  }

  return `${script}${html}`;
}

async function handleHubrisProtocolRequest(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  state: ProtocolState,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === DESKTOP_WS_BRIDGE_SCRIPT_PATH) {
    return new Response(webSocketBridgeScript(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const route = classifyHubrisRequest(request.url);
  if (route === "backend") {
    return proxyToBackend(request, cookies, targets);
  }

  if (route === "code") {
    return proxyToCodeServer(request, cookies, targets, state);
  }

  if (targets.frontendHttpOrigin) {
    return proxyFrontendHttp(request, targets);
  }

  if (!targets.frontendDistDir) {
    return new Response("frontend unavailable", { status: 404 });
  }

  return servePackagedFrontend(request, targets);
}

async function resolveHubrisWebSocketTarget(
  url: string,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  state: ProtocolState,
): Promise<string> {
  const parsed = new URL(url, HUBRIS_WS_ORIGIN);
  const route = classifyHubrisWebSocket(url, Boolean(targets.viteWsOrigin));
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;

  if (route === "backend") {
    return new URL(pathAndQuery, targets.backendWsOrigin).toString();
  }

  if (route === "code") {
    const connection = await getCodeServerConnection(cookies, targets, state);
    return new URL(
      rewriteCodeServerPath(pathAndQuery),
      connection.wsBaseUrl,
    ).toString();
  }

  if (route === "vite" && targets.viteWsOrigin) {
    return new URL(pathAndQuery, targets.viteWsOrigin).toString();
  }

  throw new Error(`unsupported websocket target: ${url}`);
}

async function proxyFrontendHttp(
  request: Request,
  targets: DesktopProtocolTargets,
): Promise<Response> {
  const frontendOrigin = targets.frontendHttpOrigin;
  if (!frontendOrigin) {
    return new Response("frontend unavailable", { status: 404 });
  }

  const url = new URL(request.url);
  const upstream = await proxyRequest(request, {
    targetUrl: new URL(
      `${url.pathname}${url.search}`,
      frontendOrigin,
    ).toString(),
    hostUrl: frontendOrigin,
    stripOrigin: true,
  });
  return maybeInjectHtml(upstream, appHtmlInjection(), false);
}

async function proxyToBackend(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await proxyRequest(request, {
    targetUrl: new URL(
      `${url.pathname}${url.search}`,
      targets.backendHttpOrigin,
    ).toString(),
    cookies,
    cookieUrl: request.url,
  });
  await mirrorResponseCookies(cookies, [HUBRIS_ORIGIN], upstream.headers);
  return stripSetCookieHeader(upstream);
}

async function proxyToCodeServer(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  state: ProtocolState,
): Promise<Response> {
  try {
    return await proxyToCodeServerWithFreshConnection(
      request,
      cookies,
      targets,
      state,
    );
  } catch (error) {
    invalidateCodeServerConnection(state);
    try {
      return await proxyToCodeServerWithFreshConnection(
        request,
        cookies,
        targets,
        state,
      );
    } catch {
      throw error;
    }
  }
}

async function proxyToCodeServerWithFreshConnection(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  state: ProtocolState,
): Promise<Response> {
  const connection = await getCodeServerConnection(cookies, targets, state);
  const url = new URL(request.url);
  const targetPath = rewriteCodeServerPath(`${url.pathname}${url.search}`);
  const upstream = await proxyRequest(request, {
    targetUrl: new URL(targetPath, connection.baseUrl).toString(),
    cookies,
    cookieUrl: request.url,
  });
  await mirrorResponseCookies(cookies, [HUBRIS_ORIGIN], upstream.headers);
  return maybeInjectHtml(upstream, codeServerHtmlInjection(), true);
}

async function proxyRequest(
  request: Request,
  options: ProxyRequestOptions,
): Promise<Response> {
  const headers = new Headers(request.headers);
  sanitizeForwardRequestHeaders(headers);
  if (options.hostUrl) {
    headers.set("host", new URL(options.hostUrl).host);
  }

  if (options.cookies && options.cookieUrl && !headers.has("cookie")) {
    const cookieHeader = await cookieHeaderForUrl(
      options.cookies,
      options.cookieUrl,
    );
    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }
  }

  if (options.stripOrigin) {
    headers.delete("origin");
    headers.delete("referer");
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return fetch(options.targetUrl, init);
}

async function getCodeServerConnection(
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  state: ProtocolState,
): Promise<CodeServerConnectionInfo> {
  if (state.codeServerConnection) {
    return state.codeServerConnection;
  }

  if (!state.codeServerConnectionPromise) {
    state.codeServerConnectionPromise = fetchCodeServerConnection(
      cookies,
      targets,
    )
      .then((connection) => {
        state.codeServerConnection = connection;
        return connection;
      })
      .finally(() => {
        state.codeServerConnectionPromise = undefined;
      });
  }

  return state.codeServerConnectionPromise;
}

function invalidateCodeServerConnection(state: ProtocolState): void {
  delete state.codeServerConnection;
  delete state.codeServerConnectionPromise;
}

async function fetchCodeServerConnection(
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
): Promise<CodeServerConnectionInfo> {
  const headers = new Headers({
    accept: "application/json",
  });
  const cookieHeader = await cookieHeaderForUrl(
    cookies,
    `${HUBRIS_ORIGIN}${CODE_SERVER_CONNECTION_PATH}`,
  );
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }

  const response = await fetch(
    new URL(CODE_SERVER_CONNECTION_PATH, targets.backendHttpOrigin),
    {
      headers,
      redirect: "manual",
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `failed to resolve code-server connection (${response.status}): ${details}`,
    );
  }

  const payload = (await response.json()) as Partial<{
    baseUrl: string;
    wsBaseUrl: string;
  }>;
  if (
    typeof payload.baseUrl !== "string" ||
    typeof payload.wsBaseUrl !== "string"
  ) {
    throw new Error("invalid code-server connection response");
  }

  return {
    baseUrl: payload.baseUrl,
    wsBaseUrl: payload.wsBaseUrl,
  };
}

async function cookieHeaderForUrl(
  cookies: CookieStore,
  url: string,
): Promise<string> {
  const cookieList = await cookies.get({ url });
  return cookieList
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function servePackagedFrontend(
  request: Request,
  targets: DesktopProtocolTargets,
): Promise<Response> {
  const distDir = targets.frontendDistDir;
  if (!distDir) {
    return new Response("frontend unavailable", { status: 404 });
  }

  const url = new URL(request.url);
  const filePath = await resolveFrontendAssetPath(distDir, url.pathname);
  if (!filePath) {
    return new Response("not found", { status: 404 });
  }

  const body = await fs.readFile(filePath);
  const headers = new Headers({
    "content-type": contentTypeForPath(filePath),
  });
  const response = new Response(body, { headers });
  return maybeInjectHtml(response, appHtmlInjection(), false);
}

async function resolveFrontendAssetPath(
  distDir: string,
  pathname: string,
): Promise<string | null> {
  const root = path.resolve(distDir);
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative);
  if (!isSubPath(root, candidate)) {
    return null;
  }

  if (await isFile(candidate)) {
    return candidate;
  }

  if (decoded.endsWith("/") || !path.extname(relative)) {
    const fallback = path.join(root, "index.html");
    return (await isFile(fallback)) ? fallback : null;
  }

  return null;
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isHubrisHttpUrl(url: URL): boolean {
  return url.protocol === "https:" && url.host === HUBRIS_HOST;
}

function isSubPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function maybeInjectHtml(
  response: Response,
  script: string,
  stripSetCookie: boolean,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!script || !contentType.startsWith("text/html")) {
    return stripSetCookie ? stripSetCookieHeader(response) : response;
  }

  const html = await response.text();
  const headers = sanitizeResponseHeaders(response.headers);
  headers.delete("content-length");
  headers.delete("set-cookie");
  return new Response(injectHtmlScript(html, script), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stripSetCookieHeader(response: Response): Response {
  const headers = sanitizeResponseHeaders(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function mirrorResponseCookies(
  cookies: CookieStore,
  origins: string[],
  headers: Headers,
): Promise<void> {
  const setCookies = getSetCookieHeaders(headers);
  if (setCookies.length === 0) {
    return;
  }

  for (const cookie of setCookies) {
    const parsed = parseSetCookie(cookie);
    if (!parsed) {
      continue;
    }

    for (const origin of origins) {
      await cookies.set({
        url: `${origin}${parsed.path}`,
        name: parsed.name,
        value: parsed.value,
        path: parsed.path,
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        sameSite: parsed.sameSite,
        ...(parsed.expirationDate !== undefined
          ? { expirationDate: parsed.expirationDate }
          : {}),
      });
    }
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getter = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof getter.getSetCookie === "function") {
    return getter.getSetCookie();
  }

  if (typeof getter.raw === "function") {
    return getter.raw()["set-cookie"] ?? [];
  }

  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function parseSetCookie(raw: string): ParsedSetCookie | null {
  const [pair, ...attributes] = raw.split(";");
  const separatorIndex = pair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const parsed: ParsedSetCookie = {
    name: pair.slice(0, separatorIndex).trim(),
    value: pair.slice(separatorIndex + 1).trim(),
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
  };

  for (const attribute of attributes) {
    const [rawKey, rawValue] = attribute.trim().split("=");
    const key = rawKey.toLowerCase();
    const value = rawValue?.trim();

    switch (key) {
      case "path":
        parsed.path = value && value.startsWith("/") ? value : "/";
        break;
      case "secure":
        parsed.secure = true;
        break;
      case "httponly":
        parsed.httpOnly = true;
        break;
      case "samesite":
        if (!value) {
          break;
        }
        parsed.sameSite =
          value.toLowerCase() === "none"
            ? "no_restriction"
            : value.toLowerCase() === "lax"
              ? "lax"
              : value.toLowerCase() === "strict"
                ? "strict"
                : "unspecified";
        break;
      case "max-age": {
        const maxAge = Number.parseInt(value ?? "", 10);
        if (Number.isFinite(maxAge)) {
          parsed.expirationDate = Date.now() / 1000 + maxAge;
        }
        break;
      }
      case "expires": {
        const expiresAt = value ? Date.parse(value) : Number.NaN;
        if (Number.isFinite(expiresAt)) {
          parsed.expirationDate = expiresAt / 1000;
        }
        break;
      }
      default:
        break;
    }
  }

  return parsed;
}

function sanitizeForwardRequestHeaders(headers: Headers): void {
  const headerNames: string[] = [];
  headers.forEach((_value, name) => {
    headerNames.push(name);
  });

  for (const header of headerNames) {
    if (
      HOP_BY_HOP_HEADERS.has(header.toLowerCase()) ||
      header.toLowerCase() === "host"
    ) {
      headers.delete(header);
    }
  }
}

function sanitizeResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      return;
    }
    headers.append(name, value);
  });
  return headers;
}
