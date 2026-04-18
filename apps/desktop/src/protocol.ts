import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { Session } from "electron";

import { readDevServerState } from "./runtime";
import { desktopWebSocketPatchSource } from "./webSocketPatch";

const require = createRequire(__filename);

const HUBRIS_PUBLIC_HOST_HEADER = "x-hubris-public-host";
const HUBRIS_PUBLIC_ORIGIN_HEADER = "x-hubris-public-origin";
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
export const HUBRIS_VSCODE_CLI_HOST = `vscode-cli.${HUBRIS_HOST}`;
export const HUBRIS_CODE_SERVER_HOST = `code-server.${HUBRIS_HOST}`;
export const HUBRIS_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_HOST}`;
export const HUBRIS_WS_ORIGIN = `wss://${HUBRIS_HOST}`;
export const HUBRIS_VSCODE_CLI_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_VSCODE_CLI_HOST}`;
export const HUBRIS_CODE_SERVER_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_CODE_SERVER_HOST}`;

const HUBRIS_INTERNAL_HOSTS = new Set([
  HUBRIS_HOST,
  HUBRIS_VSCODE_CLI_HOST,
  HUBRIS_CODE_SERVER_HOST,
]);

type VscodeRuntime = "codeServer" | "vscodeCli";

export type DesktopProtocolTargets = {
  frontendDistDir?: string;
  frontendHttpOrigin?: string;
  backendHttpOrigin: string;
  backendWsOrigin: string;
  viteWsOrigin?: string;
  devServerState?: {
    devId: string;
    devTmp: string;
  };
};

export type HubrisRouteKind = "frontend" | "backend" | "code";
export type HubrisWebSocketRouteKind = "backend" | "code" | "vite";

export type DesktopWebSocketTarget = {
  cookieUrl: string;
  publicOrigin: string;
  targetUrl: string;
  upstreamHost: string;
};

export type DesktopProtocolContext = {
  handleRequest(request: Request): Promise<Response>;
  resolveWebSocketTarget(url: string): Promise<DesktopWebSocketTarget>;
};

type CookieStore = Pick<Session, "cookies">["cookies"];

type ProtocolState = Record<string, never>;

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
  publicHost?: string;
  publicOrigin?: string;
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

  const runtime = runtimeFromHubrisHost(parsed.host);
  if (runtime) {
    return "code";
  }

  const pathname = parsed.pathname;
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/_hubris" ||
    pathname.startsWith("/_hubris/")
  ) {
    return "backend";
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
    !HUBRIS_INTERNAL_HOSTS.has(parsed.host)
  ) {
    return null;
  }

  if (runtimeFromHubrisHost(parsed.host)) {
    return "code";
  }

  const pathname = parsed.pathname;
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

export function vscodeOrigin(runtime: VscodeRuntime): string {
  return runtime === "vscodeCli"
    ? HUBRIS_VSCODE_CLI_ORIGIN
    : HUBRIS_CODE_SERVER_ORIGIN;
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
    vscodeBases: {
      codeServer: `${HUBRIS_CODE_SERVER_ORIGIN}/`,
      vscodeCli: `${HUBRIS_VSCODE_CLI_ORIGIN}/`,
    },
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

function webSocketBridgeInjection(): string {
  return ["<script>", desktopWebSocketPatchSource(), "</script>"].join("");
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
  const currentTargets = resolveCurrentTargets(targets);
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;
  const route = classifyHubrisRequest(request.url);
  try {
    if (route === "backend") {
      return await proxyToBackend(request, cookies, targets, currentTargets);
    }

    if (route === "code") {
      const runtime = runtimeFromHubrisHost(requestUrl.host);
      if (!runtime) {
        return new Response("not found", { status: 404 });
      }
      return await proxyToVscode(
        request,
        cookies,
        targets,
        currentTargets,
        state,
        runtime,
      );
    }

    if (pathname === "/code" || pathname.startsWith("/code/")) {
      return new Response("not found", { status: 404 });
    }

    if (targets.frontendHttpOrigin) {
      return await proxyFrontendHttp(request, targets, currentTargets);
    }

    if (!targets.frontendDistDir) {
      return new Response("frontend unavailable", { status: 404 });
    }

    return await servePackagedFrontend(request, targets);
  } catch (error) {
    return protocolProxyErrorResponse(error);
  }
}

async function resolveHubrisWebSocketTarget(
  url: string,
  _cookies: CookieStore,
  targets: DesktopProtocolTargets,
  _state: ProtocolState,
): Promise<DesktopWebSocketTarget> {
  const currentTargets = resolveCurrentTargets(targets);
  const parsed = new URL(url, HUBRIS_WS_ORIGIN);
  const route = classifyHubrisWebSocket(url, Boolean(targets.viteWsOrigin));
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;

  if (route === "backend") {
    const targetUrl = new URL(pathAndQuery, currentTargets.backendWsOrigin);
    return {
      cookieUrl: parsed.toString(),
      publicOrigin: `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`,
      targetUrl: targetUrl.toString(),
      upstreamHost: targetUrl.host,
    };
  }

  if (route === "code") {
    const runtime = runtimeFromHubrisHost(parsed.host);
    if (!runtime) {
      throw new Error(`unsupported websocket target: ${url}`);
    }
    const targetUrl = new URL(
      backendRuntimePath(runtime, pathAndQuery),
      currentTargets.backendWsOrigin,
    );
    return {
      cookieUrl: parsed.toString(),
      publicOrigin: `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`,
      targetUrl: targetUrl.toString(),
      upstreamHost: targetUrl.host,
    };
  }

  if (route === "vite" && currentTargets.viteWsOrigin) {
    const targetUrl = new URL(pathAndQuery, currentTargets.viteWsOrigin);
    return {
      cookieUrl: parsed.toString(),
      publicOrigin: `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`,
      targetUrl: targetUrl.toString(),
      upstreamHost: targetUrl.host,
    };
  }

  throw new Error(`unsupported websocket target: ${url}`);
}

async function proxyFrontendHttp(
  request: Request,
  targets: DesktopProtocolTargets,
  currentTargets: DesktopProtocolTargets,
): Promise<Response> {
  const frontendOrigin = currentTargets.frontendHttpOrigin;
  if (!frontendOrigin) {
    return new Response("frontend unavailable", { status: 404 });
  }

  const url = new URL(request.url);
  const upstream = await retryProxyRequest(
    request,
    targets,
    currentTargets,
    (resolvedTargets) => ({
      targetUrl: new URL(
        `${url.pathname}${url.search}`,
        resolvedTargets.frontendHttpOrigin ?? frontendOrigin,
      ).toString(),
      hostUrl: resolvedTargets.frontendHttpOrigin ?? frontendOrigin,
      stripOrigin: true,
    }),
  );
  return maybeInjectHtml(upstream, appHtmlInjection(), false);
}

async function proxyToBackend(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  currentTargets: DesktopProtocolTargets,
): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await retryProxyRequest(
    request,
    targets,
    currentTargets,
    (resolvedTargets) => ({
      targetUrl: new URL(
        `${url.pathname}${url.search}`,
        resolvedTargets.backendHttpOrigin,
      ).toString(),
      cookies,
      cookieUrl: request.url,
    }),
  );
  await mirrorResponseCookies(cookies, [HUBRIS_ORIGIN], upstream.headers);
  return stripSetCookieHeader(upstream);
}

async function proxyToVscode(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  currentTargets: DesktopProtocolTargets,
  state: ProtocolState,
  runtime: VscodeRuntime,
): Promise<Response> {
  return proxyToVscodeViaBackend(
    request,
    cookies,
    targets,
    currentTargets,
    state,
    runtime,
  );
}

async function proxyToVscodeViaBackend(
  request: Request,
  cookies: CookieStore,
  targets: DesktopProtocolTargets,
  currentTargets: DesktopProtocolTargets,
  _state: ProtocolState,
  runtime: VscodeRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await retryProxyRequest(
    request,
    targets,
    currentTargets,
    (resolvedTargets) => ({
      targetUrl: new URL(
        backendRuntimePath(runtime, `${url.pathname}${url.search}`),
        resolvedTargets.backendHttpOrigin,
      ).toString(),
      cookies,
      cookieUrl: request.url,
      publicHost: url.host,
      publicOrigin: url.origin,
    }),
  );
  await mirrorResponseCookies(cookies, [url.origin], upstream.headers);
  return stripSetCookieHeader(upstream);
}

async function retryProxyRequest(
  request: Request,
  targets: DesktopProtocolTargets,
  currentTargets: DesktopProtocolTargets,
  buildOptions: (
    resolvedTargets: DesktopProtocolTargets,
  ) => ProxyRequestOptions,
): Promise<Response> {
  const retryRequest =
    request.method === "GET" || request.method === "HEAD"
      ? request
      : request.clone();
  const first = buildOptions(currentTargets);
  try {
    return await proxyRequest(request, first);
  } catch (error) {
    if (!targets.devServerState) {
      throw error;
    }

    await delay(100);
    const refreshedTargets = resolveCurrentTargets(targets);
    return proxyRequest(retryRequest, buildOptions(refreshedTargets));
  }
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
  if (options.publicHost) {
    headers.set(HUBRIS_PUBLIC_HOST_HEADER, options.publicHost);
  }
  if (options.publicOrigin) {
    headers.set(HUBRIS_PUBLIC_ORIGIN_HEADER, options.publicOrigin);
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

function resolveCurrentTargets(
  targets: DesktopProtocolTargets,
): DesktopProtocolTargets {
  const devState = targets.devServerState;
  if (!devState) {
    return targets;
  }

  const frontend = readDevServerState(
    "frontend",
    devState.devId,
    devState.devTmp,
  );
  const backend = readDevServerState(
    "backend",
    devState.devId,
    devState.devTmp,
  );

  return {
    ...targets,
    ...(frontend
      ? {
          frontendHttpOrigin: `http://localhost:${frontend.port}`,
          viteWsOrigin: `ws://localhost:${frontend.port}`,
        }
      : {}),
    ...(backend
      ? {
          backendHttpOrigin: `http://127.0.0.1:${backend.port}`,
          backendWsOrigin: `ws://127.0.0.1:${backend.port}`,
        }
      : {}),
  };
}

function runtimeFromHubrisHost(host: string): VscodeRuntime | null {
  if (host === HUBRIS_VSCODE_CLI_HOST) {
    return "vscodeCli";
  }
  if (host === HUBRIS_CODE_SERVER_HOST) {
    return "codeServer";
  }
  return null;
}

function runtimeRouteSegment(runtime: VscodeRuntime): string {
  return runtime === "vscodeCli" ? "vscode-cli" : "code-server";
}

function publicBasePath(runtime: VscodeRuntime): string {
  return `/code/${runtimeRouteSegment(runtime)}`;
}

function normalizeRuntimePath(pathAndQuery: string): string {
  if (pathAndQuery === "") {
    return "/";
  }
  if (pathAndQuery.startsWith("/") || pathAndQuery.startsWith("?")) {
    return `/${pathAndQuery.replace(/^\/+/, "")}`;
  }
  return `/${pathAndQuery}`;
}

function backendRuntimePath(
  runtime: VscodeRuntime,
  pathAndQuery: string,
): string {
  return `${publicBasePath(runtime)}${normalizeRuntimeHostPath(runtime, pathAndQuery)}`;
}

function normalizeRuntimeHostPath(
  runtime: VscodeRuntime,
  pathAndQuery: string,
): string {
  const normalized = normalizeRuntimePath(pathAndQuery);
  const publicBase = publicBasePath(runtime);
  if (normalized === publicBase) {
    return "/";
  }
  if (normalized.startsWith(`${publicBase}/`)) {
    return normalized.slice(publicBase.length);
  }
  if (normalized.startsWith(`${publicBase}?`)) {
    return normalized.slice(publicBase.length);
  }
  return normalized;
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
  return url.protocol === "https:" && HUBRIS_INTERNAL_HOSTS.has(url.host);
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function protocolProxyErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(message, { status: 502 });
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
