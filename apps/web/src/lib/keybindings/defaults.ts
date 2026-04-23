import type { CommandArgsById, CommandId } from "@/lib/commands";

export type KeybindingDefinition<TId extends CommandId = CommandId> = {
  args?: CommandArgsById[TId];
  command?: TId;
  disabled?: boolean;
  key: string;
  source: "default" | "user";
  when?: string;
};

const WORKBENCH_SAFE = [
  "selectedWorktree",
  "!inputFocus",
  "!terminalFocus",
  "!browserFocus",
  "!editorFocus",
  "!commandPaletteOpen",
  "!dialogOpen",
].join(" && ");

export const defaultKeybindings = [
  {
    command: "app.openCommandPalette",
    key: "mod+k",
    source: "default",
    when: "!inputFocus",
  },
  {
    command: "app.openSettings",
    key: "mod+,",
    source: "default",
    when: "!inputFocus && !terminalFocus && !browserFocus && !editorFocus",
  },
  {
    command: "tab.newTerminal",
    key: "mod+t",
    source: "default",
    when: WORKBENCH_SAFE,
  },
  {
    command: "tab.newBrowser",
    key: "mod+alt+b",
    source: "default",
    when: WORKBENCH_SAFE,
  },
  {
    command: "tab.close",
    key: "mod+w",
    source: "default",
    when: WORKBENCH_SAFE,
  },
  {
    command: "tab.pin",
    key: "mod+shift+enter",
    source: "default",
    when: `${WORKBENCH_SAFE} && activeTabPreview`,
  },
  {
    command: "pane.splitRight",
    key: "mod+\\",
    source: "default",
    when: `${WORKBENCH_SAFE} && focusedPane`,
  },
  {
    command: "pane.splitDown",
    key: "mod+shift+\\",
    source: "default",
    when: `${WORKBENCH_SAFE} && focusedPane`,
  },
] as const satisfies readonly KeybindingDefinition[];
