import { getPlatformFlags } from "./keys";
import type { KeybindingWhenContext } from "./when";

/** Permissive sample context used to validate user-authored `when` strings. */
export const KEYBINDING_VALIDATION_CONTEXT = {
  activeTabPreview: false,
  activeTabType: "terminal",
  browserFocus: false,
  commandPaletteOpen: false,
  dialogOpen: false,
  editorFocus: false,
  focusedPane: true,
  gitStatusFocus: false,
  inputFocus: false,
  ...getPlatformFlags(),
  selectedProject: true,
  selectedWorktree: true,
  terminalFocus: false,
} satisfies KeybindingWhenContext;
