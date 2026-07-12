import type { DesktopRuntimeConfig } from "@/lib/desktopRuntimeConfig.generated";

function runtimeConfig(): DesktopRuntimeConfig | null {
  return window.__HUBRIS_DESKTOP_CONFIG__ ?? null;
}

export function apiBase(): string {
  return runtimeConfig()?.apiBase ?? "/api";
}

export function eventsUrl(sessionId = "default"): string {
  const base = runtimeConfig()?.eventsUrl;
  if (!base) {
    return `/api/events?session_id=${encodeURIComponent(sessionId)}`;
  }

  const url = new URL(base);
  url.searchParams.set("session_id", sessionId);
  return url.toString();
}

export function terminalWsUrlBase(): string {
  return runtimeConfig()?.terminalWsBase ?? "";
}

export function vscodeBase(runtime: "codeServer" | "vscodeCli"): string {
  const base = runtimeConfig()?.vscodeBases?.[runtime];
  if (base) {
    return base;
  }

  return runtime === "vscodeCli" ? "/code/vscode-cli/" : "/code/code-server/";
}

export function resetDesktopRuntimeConfigForTests(): void {
  delete window.__HUBRIS_DESKTOP_CONFIG__;
}
