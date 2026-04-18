type BrowserViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type VscodeRuntime = "codeServer" | "vscodeCli";

type VscodeViewRequest = {
  worktreeId: string;
};

type VscodeViewLoadRequest = {
  worktreeId: string;
  runtime: VscodeRuntime;
  worktreePath: string;
};

type VscodeViewSetBoundsRequest = {
  worktreeId: string;
  bounds: BrowserViewBounds;
};

type DesktopVscodeBridge = {
  create: (payload: VscodeViewLoadRequest) => Promise<void>;
  load: (payload: VscodeViewLoadRequest) => void;
  show: (payload: VscodeViewRequest) => void;
  hide: (payload: VscodeViewRequest) => void;
  setBounds: (payload: VscodeViewSetBoundsRequest) => void;
  destroy: (payload: VscodeViewRequest) => void;
};

declare global {
  interface Window {
    __HUBRIS_ELECTRON_VSCODE__?: DesktopVscodeBridge;
  }
}

export type { BrowserViewBounds, VscodeRuntime };

/** Return the Electron VS Code bridge when running in desktop mode. */
export function desktopVscodeBridge(): DesktopVscodeBridge | null {
  return window.__HUBRIS_ELECTRON_VSCODE__ ?? null;
}

/** Whether the current renderer can talk to the desktop VS Code bridge. */
export function hasDesktopVscodeBridge(): boolean {
  return desktopVscodeBridge() !== null;
}
