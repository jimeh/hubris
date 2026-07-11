export * from "@/lib/api/chats";
export * from "@/lib/api/editorThemes";
export * from "@/lib/api/files";
export * from "@/lib/api/keybindings";
export * from "@/lib/api/projects";
export * from "@/lib/api/settings";
export * from "@/lib/api/system";
export * from "@/lib/api/tabs";
export * from "@/lib/api/vscode";
export * from "@/lib/api/worktrees";
export { ApiStatusError } from "@/lib/api/client";

import { terminalWsUrlBase } from "@/lib/desktopRuntime";

export function terminalWsUrl(tabId: string): string {
  const base = terminalWsUrlBase();
  if (base) {
    const url = new URL(base);
    url.searchParams.set("tab_id", tabId);
    return url.toString();
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/terminal/ws?tab_id=${encodeURIComponent(tabId)}`;
}
