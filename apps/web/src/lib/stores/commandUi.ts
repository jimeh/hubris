import { create } from "zustand";
import type { SectionName } from "@/components/settings-dialog/sections";

export type CommandDialogIntent =
  | { type: "add-project" }
  | { type: "add-worktree"; projectId: string }
  | { type: "rename-project"; projectId: string }
  | { type: "rename-worktree"; projectId: string; worktreeId: string }
  | {
      type: "remove-project";
      projectId: string;
      forceManagedDelete?: boolean;
    }
  | {
      type: "remove-worktree";
      projectId: string;
      worktreeId: string;
      forceDelete?: boolean;
    }
  | { type: "rename-terminal-tab"; tabId: string }
  | { type: "settings"; section?: SectionName }
  | { type: "close-dirty-tab"; tabId: string };

type CommandUiState = {
  paletteOpen: boolean;
  paletteQuery: string;
  dialog: CommandDialogIntent | null;
  openPalette: () => void;
  closePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  setPaletteQuery: (query: string) => void;
  openDialog: (dialog: CommandDialogIntent) => void;
  closeDialog: () => void;
};

const initialState = {
  paletteOpen: false,
  paletteQuery: "",
  dialog: null,
} satisfies Pick<CommandUiState, "paletteOpen" | "paletteQuery" | "dialog">;

export const useCommandUiStore = create<CommandUiState>((set) => ({
  ...initialState,
  openPalette() {
    set({ paletteOpen: true });
  },
  closePalette() {
    set({ paletteOpen: false, paletteQuery: "" });
  },
  setPaletteOpen(open) {
    set(
      open ? { paletteOpen: true } : { paletteOpen: false, paletteQuery: "" },
    );
  },
  setPaletteQuery(paletteQuery) {
    set({ paletteQuery });
  },
  openDialog(dialog) {
    set({ dialog, paletteOpen: false, paletteQuery: "" });
  },
  closeDialog() {
    set({ dialog: null });
  },
}));

export function resetCommandUiStoreForTests(): void {
  useCommandUiStore.setState(initialState);
}
