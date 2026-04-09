import { create } from "zustand";

type VscodeWorkbenchState = {
  loadedWorktreeIds: string[];
  markLoaded: (worktreeId: string) => void;
  pruneMissing: (worktreeIds: string[]) => void;
};

/** Tracks VS Code workbenches retained in the current browser tab. */
export const useVscodeWorkbenchStore = create<VscodeWorkbenchState>((set) => ({
  loadedWorktreeIds: [],
  markLoaded(worktreeId) {
    set((state) =>
      state.loadedWorktreeIds.includes(worktreeId)
        ? state
        : {
            loadedWorktreeIds: [...state.loadedWorktreeIds, worktreeId],
          },
    );
  },
  pruneMissing(worktreeIds) {
    const validIds = new Set(worktreeIds);

    set((state) => {
      const loadedWorktreeIds = state.loadedWorktreeIds.filter((worktreeId) =>
        validIds.has(worktreeId),
      );

      return loadedWorktreeIds.length === state.loadedWorktreeIds.length
        ? state
        : { loadedWorktreeIds };
    });
  },
}));

/** Resets the transient VS Code workbench cache between tests. */
export function resetVscodeWorkbenchStoreForTests(): void {
  useVscodeWorkbenchStore.setState({ loadedWorktreeIds: [] });
}
