export const MISSING_BROWSER_URL_MESSAGE = "Enter a URL.";
export const INVALID_BROWSER_URL_MESSAGE =
  "Only http:// and https:// URLs are supported.";

function shouldAssumeHttp(trimmed: string): boolean {
  if (trimmed.includes("://")) {
    return false;
  }

  const host = trimmed.split("/")[0]?.split("?")[0]?.split("#")[0]?.trim();
  if (!host) {
    return false;
  }

  if (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]")
  ) {
    return true;
  }

  const portSeparator = host.lastIndexOf(":");
  if (portSeparator <= 0 || portSeparator === host.length - 1) {
    return false;
  }

  return /^\d+$/.test(host.slice(portSeparator + 1));
}

/** Normalize browser-tab input into a canonical http(s) URL. */
export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(MISSING_BROWSER_URL_MESSAGE);
  }

  const candidate = shouldAssumeHttp(trimmed) ? `http://${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(INVALID_BROWSER_URL_MESSAGE);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(INVALID_BROWSER_URL_MESSAGE);
  }

  return parsed.toString();
}

/** Derive a compact tab label from a browser-tab URL. */
export function browserLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}
