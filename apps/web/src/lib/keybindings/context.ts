import { getCommandContextSnapshot } from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import type { KeybindingWhenContext } from "./when";

export function getKeybindingWhenContext(target: EventTarget | null) {
  const commandContext = getCommandContextSnapshot();
  const element = target instanceof Element ? target : document.activeElement;
  const inputFocus = isEditableElement(element);
  const activeTabType = commandContext.activeTab?.type ?? null;
  const terminalFocus = activeTabType === "terminal" && !inputFocus;
  const browserFocus = activeTabType === "browser" && !inputFocus;
  const editorFocus =
    (activeTabType === "file" || activeTabType === "git_diff") && !inputFocus;
  const commandUi = useCommandUiStore.getState();

  return {
    activeTabPreview: !!commandContext.activeTab?.preview,
    activeTabType,
    browserFocus,
    commandPaletteOpen: commandUi.paletteOpen,
    dialogOpen: commandUi.dialog !== null,
    editorFocus,
    focusedPane: commandContext.focusedPaneId !== null,
    gitStatusFocus:
      element?.closest("[data-git-status-section-header]") !== null,
    inputFocus,
    selectedProject: commandContext.selectedProject !== null,
    selectedWorktree: commandContext.selectedWorktree !== null,
    terminalFocus,
  } satisfies KeybindingWhenContext;
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

  return element.closest(".monaco-editor, .xterm-helper-textarea") !== null;
}
