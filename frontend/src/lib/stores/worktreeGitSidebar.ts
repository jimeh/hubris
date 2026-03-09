import { create } from "zustand";

const LS_DESKTOP_OPEN = "hubris-worktree-git-sidebar-open";

type WorktreeGitSidebarState = {
  desktopOpen: boolean;
  mobileOpen: boolean;
  setDesktopOpen: (open: boolean) => void;
  toggleDesktop: () => void;
  setMobileOpen: (open: boolean) => void;
  toggleForViewport: (isMobile: boolean) => void;
};

function readDesktopOpen(): boolean {
  try {
    const raw = localStorage.getItem(LS_DESKTOP_OPEN);
    if (raw == null) {
      return true;
    }
    return raw !== "false";
  } catch {
    return true;
  }
}

function writeDesktopOpen(open: boolean): void {
  try {
    localStorage.setItem(LS_DESKTOP_OPEN, String(open));
  } catch {
    // localStorage unavailable
  }
}

export const useWorktreeGitSidebarStore = create<WorktreeGitSidebarState>(
  (set, get) => ({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    setDesktopOpen(open) {
      writeDesktopOpen(open);
      set({ desktopOpen: open });
    },
    toggleDesktop() {
      const next = !get().desktopOpen;
      writeDesktopOpen(next);
      set({ desktopOpen: next });
    },
    setMobileOpen(mobileOpen) {
      set({ mobileOpen });
    },
    toggleForViewport(isMobile) {
      if (isMobile) {
        set((state) => ({ mobileOpen: !state.mobileOpen }));
        return;
      }
      const next = !get().desktopOpen;
      writeDesktopOpen(next);
      set({ desktopOpen: next });
    },
  }),
);

export function resetWorktreeGitSidebarStoreForTests(): void {
  useWorktreeGitSidebarStore.setState({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
  });
}
