import { create } from "zustand";

type HubrisWorkbenchState = {
  loadedWorktreeIds: string[];
  markLoaded: (worktreeId: string) => void;
  pruneMissing: (worktreeIds: string[]) => void;
};

/** Tracks Hubris worktree views retained in the current browser tab. */
export const useHubrisWorkbenchStore = create<HubrisWorkbenchState>((set) => ({
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

/** Resets the transient Hubris workbench cache between tests. */
export function resetHubrisWorkbenchStoreForTests(): void {
  useHubrisWorkbenchStore.setState({ loadedWorktreeIds: [] });
}
