import { useEffect } from "react";
import { executeCommand, type CommandArgsById } from "@/lib/commands";
import {
  getKeybindingWhenContext,
  isPlainEditableElement,
} from "@/lib/keybindings/context";
import {
  keybindingFromEvent,
  normalizeKeybinding,
} from "@/lib/keybindings/keys";
import { resolveKeybinding } from "@/lib/keybindings/registry";
import { useKeybindingsStore } from "@/lib/stores/keybindings";
import { useSettingsStore } from "@/lib/stores/settings";
import { useWorktreeHistorySwitcherStore } from "@/lib/stores/worktreeHistorySwitcher";

const RESERVED_BROWSER_KEYS = new Set(["meta+r", "ctrl+r"]);

function isCtrlTab(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "Tab" || event.code === "Tab")
  );
}

export default function KeyboardShortcuts() {
  const registry = useKeybindingsStore((state) => state.registry);
  const sendKeybindingsToShell = useSettingsStore(
    (state) => state.settings.terminal.sendKeybindingsToShell,
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      const switcher = useWorktreeHistorySwitcherStore.getState();
      if (switcher.open) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          switcher.cancel();
          return;
        }

        if (isCtrlTab(event)) {
          event.preventDefault();
          event.stopPropagation();
          switcher.cycle(event.shiftKey ? "forward" : "back");
          return;
        }
      }

      const key = keybindingFromEvent(event);
      if (RESERVED_BROWSER_KEYS.has(normalizeKeybinding(key))) {
        return;
      }

      const context = getKeybindingWhenContext(event.target);
      if (sendKeybindingsToShell && context.terminalFocus) {
        return;
      }

      const binding = resolveKeybinding({ context, key, registry });
      if (!binding?.command) {
        return;
      }

      if (binding.command === "worktree.showHistorySwitcher") {
        const target = event.target instanceof Element ? event.target : null;
        if (
          context.commandPaletteOpen ||
          context.dialogOpen ||
          (isPlainEditableElement(target) &&
            !context.terminalFocus &&
            context.activeTabType !== "browser")
        ) {
          return;
        }
      }

      event.preventDefault();
      event.stopPropagation();
      void executeCommand({
        args: binding.args as CommandArgsById[typeof binding.command],
        id: binding.command,
        source: "keyboard-shortcut",
      });
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (event.key !== "Control") {
        return;
      }

      const worktreeId = useWorktreeHistorySwitcherStore.getState().commit();
      if (!worktreeId) {
        return;
      }

      void executeCommand({
        args: { worktreeId },
        id: "worktree.select",
        source: "keyboard-shortcut",
      });
    }

    function cancelSwitcher(): void {
      useWorktreeHistorySwitcherStore.getState().cancel();
    }

    function handleVisibilityChange(): void {
      if (document.hidden) {
        cancelSwitcher();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", cancelSwitcher);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", cancelSwitcher);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [registry, sendKeybindingsToShell]);

  return null;
}
