export const BLANK_BROWSER_URL = "about:blank";
export const BROWSER_PREVIEW_PROXY_BASE_PATH = "/_hubris/browser-preview";
export const MISSING_BROWSER_URL_MESSAGE = "Enter a URL.";
export const INVALID_BROWSER_URL_MESSAGE =
  "Only http:// and https:// URLs are supported.";

export type BrowserUrlInput =
  | {
      kind: "blank";
      url: typeof BLANK_BROWSER_URL;
    }
  | {
      kind: "absolute";
      url: string;
    }
  | {
      kind: "scheme-unspecified";
      raw: string;
      httpUrl: string;
      httpsUrl: string;
    };

function parseUrl(candidate: string): URL {
  try {
    return new URL(candidate);
  } catch {
    throw new Error(INVALID_BROWSER_URL_MESSAGE);
  }
}

function isSupportedProtocol(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function hostCandidate(trimmed: string): string {
  return trimmed.split("/")[0]?.split("?")[0]?.split("#")[0]?.trim() ?? "";
}

function shouldTreatAsHostInput(trimmed: string): boolean {
  if (!trimmed || trimmed.includes("://")) {
    return false;
  }

  if (/\s/.test(trimmed)) {
    return false;
  }

  const host = hostCandidate(trimmed);
  if (!host) {
    return false;
  }

  return parseUrl(`http://${trimmed}`).host.length > 0;
}

/** Parse browser-tab input without collapsing scheme-less host input. */
export function parseBrowserUrlInput(
  raw: string,
  options: { allowBlank?: boolean } = {},
): BrowserUrlInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(MISSING_BROWSER_URL_MESSAGE);
  }

  if (options.allowBlank && trimmed === BLANK_BROWSER_URL) {
    return { kind: "blank", url: BLANK_BROWSER_URL };
  }

  if (trimmed.includes("://")) {
    const parsed = parseUrl(trimmed);
    if (!isSupportedProtocol(parsed)) {
      throw new Error(INVALID_BROWSER_URL_MESSAGE);
    }
    return { kind: "absolute", url: parsed.toString() };
  }

  if (!shouldTreatAsHostInput(trimmed)) {
    throw new Error(INVALID_BROWSER_URL_MESSAGE);
  }

  return {
    kind: "scheme-unspecified",
    raw: trimmed,
    httpUrl: parseUrl(`http://${trimmed}`).toString(),
    httpsUrl: parseUrl(`https://${trimmed}`).toString(),
  };
}

/** Normalize a persisted browser-tab URL value. */
export function normalizeBrowserUrl(
  raw: string,
  options: { allowBlank?: boolean } = {},
): string {
  const parsed = parseBrowserUrlInput(raw, options);
  if (parsed.kind === "blank") {
    return parsed.url;
  }
  if (parsed.kind === "absolute") {
    return parsed.url;
  }
  return parsed.httpUrl;
}

/** Show an empty location bar for the blank browser-tab bootstrap state. */
export function browserInputValue(url: string): string {
  return url === BLANK_BROWSER_URL ? "" : url;
}

/** Whether the URL targets a loopback preview host we can proxy safely. */
export function isLoopbackBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

/** Build the same-origin preview proxy path for loopback browser tabs. */
export function browserPreviewProxyUrl(url: string): string | null {
  if (!isLoopbackBrowserUrl(url)) {
    return null;
  }

  const parsed = parseUrl(url);
  const scheme = parsed.protocol.slice(0, -1);
  const authority = encodeURIComponent(parsed.host);
  return `${BROWSER_PREVIEW_PROXY_BASE_PATH}/${scheme}/${authority}${
    parsed.pathname || "/"
  }${parsed.search}`;
}

/** Decode a same-origin proxy iframe URL back into the underlying loopback URL. */
export function decodeBrowserPreviewProxyUrl(
  url: string,
  origin = window.location.origin,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }

  if (parsed.origin !== origin) {
    return null;
  }

  const path = parsed.pathname;
  if (!path.startsWith(`${BROWSER_PREVIEW_PROXY_BASE_PATH}/`)) {
    return null;
  }

  const remainder = path.slice(BROWSER_PREVIEW_PROXY_BASE_PATH.length + 1);
  const parts = remainder.split("/");
  const [scheme, encodedAuthority, ...rest] = parts;
  if (!scheme || !encodedAuthority) {
    return null;
  }

  let authority: string;
  try {
    authority = decodeURIComponent(encodedAuthority);
  } catch {
    return null;
  }
  const upstreamPath = rest.length > 0 ? `/${rest.join("/")}` : "/";
  const candidate = `${scheme}://${authority}${upstreamPath}${parsed.search}`;

  return isLoopbackBrowserUrl(candidate) ? candidate : null;
}

/** Derive the iframe source, preferring the same-origin loopback proxy. */
export function browserFrameSrc(url: string): string {
  if (url === BLANK_BROWSER_URL) {
    return url;
  }

  return browserPreviewProxyUrl(url) ?? url;
}

/** Derive a compact tab label from a browser-tab URL. */
export function browserLabelFromUrl(url: string): string {
  if (url === BLANK_BROWSER_URL) {
    return "New Browser";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}
