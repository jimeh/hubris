import { useEffect } from "react";
import { executeCommand, type CommandArgsById } from "@/lib/commands";
import { getKeybindingWhenContext } from "@/lib/keybindings/context";
import { keybindingFromEvent } from "@/lib/keybindings/keys";
import { resolveKeybinding } from "@/lib/keybindings/registry";
import { useKeybindingsStore } from "@/lib/stores/keybindings";
import { useSettingsStore } from "@/lib/stores/settings";

const RESERVED_BROWSER_KEYS = new Set(["meta+r", "ctrl+r"]);

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

      const key = keybindingFromEvent(event);
      if (RESERVED_BROWSER_KEYS.has(key)) {
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

      event.preventDefault();
      void executeCommand({
        args: binding.args as CommandArgsById[typeof binding.command],
        id: binding.command,
        source: "keyboard-shortcut",
      });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [registry, sendKeybindingsToShell]);

  return null;
}
