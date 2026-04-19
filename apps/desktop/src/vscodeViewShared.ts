import type { BrowserViewBounds } from "./browserViewShared";

export const HUBRIS_VSCODE_CREATE_CHANNEL = "hubris:vscode-create";
export const HUBRIS_VSCODE_DESTROY_CHANNEL = "hubris:vscode-destroy";
export const HUBRIS_VSCODE_HIDE_CHANNEL = "hubris:vscode-hide";
export const HUBRIS_VSCODE_LOAD_CHANNEL = "hubris:vscode-load";
export const HUBRIS_VSCODE_SET_BOUNDS_CHANNEL = "hubris:vscode-set-bounds";
export const HUBRIS_VSCODE_SHOW_CHANNEL = "hubris:vscode-show";

export type VscodeRuntime = "codeServer" | "vscodeCli";

export type VscodeViewRequest = {
  worktreeId: string;
};

export type VscodeViewLoadRequest = {
  worktreeId: string;
  runtime: VscodeRuntime;
  worktreePath: string;
};

export type VscodeViewSetBoundsRequest = {
  worktreeId: string;
  bounds: BrowserViewBounds;
};
