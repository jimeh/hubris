import { create } from "zustand";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Worktree } from "@/lib/types";

export type WorktreeHistoryDirection = "back" | "forward";

type WorktreeHistorySwitcherState = {
  items: string[];
  open: boolean;
  selectedIndex: number;
  cancel: () => void;
  commit: () => string | null;
  cycle: (direction: WorktreeHistoryDirection) => void;
  selectIndex: (index: number) => void;
  start: (items: string[], direction: WorktreeHistoryDirection) => boolean;
};

export function buildWorktreeHistoryItems(input: {
  navigationBackIds: string[];
  selectedWorktreeId: string | null;
  worktreesByProject: Record<string, Worktree[]>;
}): string[] {
  if (!input.selectedWorktreeId) {
    return [];
  }

  const validIds = new Set(
    Object.values(input.worktreesByProject)
      .flat()
      .map((worktree) => worktree.id),
  );
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of [input.selectedWorktreeId, ...input.navigationBackIds]) {
    if (!validIds.has(id) || seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push(id);
  }

  return result;
}

export function nextWorktreeHistoryIndex(
  currentIndex: number,
  itemCount: number,
  direction: WorktreeHistoryDirection,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  const offset = direction === "back" ? 1 : -1;
  return (currentIndex + offset + itemCount) % itemCount;
}

function closeState(): Pick<
  WorktreeHistorySwitcherState,
  "items" | "open" | "selectedIndex"
> {
  return { items: [], open: false, selectedIndex: 0 };
}

export const useWorktreeHistorySwitcherStore =
  create<WorktreeHistorySwitcherState>((set, get) => ({
    ...closeState(),
    cancel() {
      set(closeState());
    },
    commit() {
      const state = get();
      const worktreeId = state.items[state.selectedIndex];
      set(closeState());

      if (!state.open || !worktreeId) {
        return null;
      }

      return worktreeId;
    },
    cycle(direction) {
      set((state) =>
        state.open
          ? {
              selectedIndex: nextWorktreeHistoryIndex(
                state.selectedIndex,
                state.items.length,
                direction,
              ),
            }
          : state,
      );
    },
    selectIndex(index) {
      set((state) =>
        state.open && index >= 0 && index < state.items.length
          ? { selectedIndex: index }
          : state,
      );
    },
    start(items, direction) {
      if (items.length < 2) {
        set(closeState());
        return false;
      }

      set({
        items,
        open: true,
        selectedIndex: nextWorktreeHistoryIndex(0, items.length, direction),
      });
      return true;
    },
  }));

export function getCurrentWorktreeHistoryItems(): string[] {
  const worktreeState = useWorktreeStore.getState();
  return buildWorktreeHistoryItems({
    navigationBackIds: worktreeState.navigationBackIds,
    selectedWorktreeId: worktreeState.selectedWorktreeId,
    worktreesByProject: worktreeState.worktreesByProject,
  });
}
