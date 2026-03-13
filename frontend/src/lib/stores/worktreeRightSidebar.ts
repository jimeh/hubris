import { create } from "zustand";
import {
  DEFAULT_WORKTREE_RIGHT_SIDEBAR_PANEL,
  type WorktreeRightSidebarPanelId,
} from "@/lib/worktreeRightSidebar";

const LS_DESKTOP_OPEN = "hubris-worktree-right-sidebar-open";
const LS_LEGACY_DESKTOP_OPEN = "hubris-worktree-git-sidebar-open";

type WorktreeRightSidebarState = {
  desktopOpen: boolean;
  mobileOpen: boolean;
  activePanel: WorktreeRightSidebarPanelId;
  setDesktopOpen: (open: boolean) => void;
  toggleDesktop: () => void;
  setMobileOpen: (open: boolean) => void;
  closeForViewport: (isMobile: boolean) => void;
  openPanel: (panelId: WorktreeRightSidebarPanelId, isMobile: boolean) => void;
};

function readDesktopOpen(): boolean {
  try {
    const raw =
      localStorage.getItem(LS_DESKTOP_OPEN) ??
      localStorage.getItem(LS_LEGACY_DESKTOP_OPEN);
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

export const useWorktreeRightSidebarStore = create<WorktreeRightSidebarState>(
  (set, get) => ({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    activePanel: DEFAULT_WORKTREE_RIGHT_SIDEBAR_PANEL,
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
    closeForViewport(isMobile) {
      if (isMobile) {
        set({ mobileOpen: false });
        return;
      }

      writeDesktopOpen(false);
      set({ desktopOpen: false });
    },
    openPanel(panelId, isMobile) {
      if (isMobile) {
        set({ activePanel: panelId, mobileOpen: true });
        return;
      }

      writeDesktopOpen(true);
      set({ activePanel: panelId, desktopOpen: true });
    },
  }),
);

export function resetWorktreeRightSidebarStoreForTests(): void {
  useWorktreeRightSidebarStore.setState({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    activePanel: DEFAULT_WORKTREE_RIGHT_SIDEBAR_PANEL,
  });
}
