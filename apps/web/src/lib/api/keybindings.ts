import type {
  KeybindingEntry,
  KeybindingsState,
} from "@/lib/contracts/sse.generated";
import { requestJson } from "./client";

export async function getKeybindings(): Promise<KeybindingsState> {
  return (await requestJson("GET", "/api/keybindings", {})) as KeybindingsState;
}

export async function replaceKeybindings(
  keybindings: KeybindingEntry[],
): Promise<KeybindingsState> {
  return (await requestJson("PUT", "/api/keybindings", {
    body: keybindings,
  })) as KeybindingsState;
}
