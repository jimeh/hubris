import { getCommandContextSnapshot } from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { getPlatformFlags } from "./keys";
import type { KeybindingWhenContext } from "./when";

export function getKeybindingWhenContext(target: EventTarget | null) {
  const commandContext = getCommandContextSnapshot();
  const element = target instanceof Element ? target : document.activeElement;
  const inputFocus = isEditableElement(element);
  const activeTabType = commandContext.activeTab?.type ?? null;
  const terminalFocus =
    activeTabType === "terminal" && isTerminalElement(element);
  const browserFocus = activeTabType === "browser" && isBrowserElement(element);
  const editorFocus =
    (activeTabType === "file" || activeTabType === "git_diff") &&
    isEditorElement(element);
  const commandUi = useCommandUiStore.getState();

  return {
    activeTabPreview: !!commandContext.activeTab?.preview,
    activeTabType,
    browserFocus,
    commandPaletteOpen: commandUi.paletteOpen,
    dialogOpen: commandUi.dialog !== null,
    editorFocus,
    focusedPane: commandContext.focusedPaneId !== null,
    gitStatusFocus: element?.closest("[data-git-status]") != null,
    inputFocus,
    ...getPlatformFlags(),
    selectedProject: commandContext.selectedProject !== null,
    selectedWorktree: commandContext.selectedWorktree !== null,
    terminalFocus,
  } satisfies KeybindingWhenContext;
}

function isTerminalElement(element: Element | null): boolean {
  return (
    element?.closest(
      ".terminal-wrapper, .terminal-container, .xterm, .xterm-helper-textarea",
    ) != null
  );
}

function isBrowserElement(element: Element | null): boolean {
  return element?.closest("[data-browser-content]") != null;
}

function isEditorElement(element: Element | null): boolean {
  return element?.closest(".monaco-editor") != null;
}

export function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }

  if (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.closest("[contenteditable='true']"))
  ) {
    return true;
  }

  return (
    element.closest(
      ".monaco-editor, .xterm-helper-textarea, .terminal-wrapper",
    ) !== null
  );
}

export function isPlainEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }

  if (element.closest(".monaco-editor, .terminal-wrapper, .xterm")) {
    return false;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }

  return (
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.closest("[contenteditable='true']") !== null)
  );
}
