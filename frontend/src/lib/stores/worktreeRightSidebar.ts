import { create } from "zustand";
import {
  DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB,
  type WorktreeRightSidebarTabId,
} from "@/lib/worktreeRightSidebar";

const LS_DESKTOP_OPEN = "hubris-worktree-right-sidebar-open";
const LS_LEGACY_DESKTOP_OPEN = "hubris-worktree-git-sidebar-open";
const LS_ACTIVE_TAB = "hubris-worktree-right-sidebar-tab";

type WorktreeRightSidebarState = {
  desktopOpen: boolean;
  mobileOpen: boolean;
  activeTab: WorktreeRightSidebarTabId;
  setDesktopOpen: (open: boolean) => void;
  toggleDesktop: () => void;
  setMobileOpen: (open: boolean) => void;
  closeForViewport: (isMobile: boolean) => void;
  openTab: (tabId: WorktreeRightSidebarTabId, isMobile: boolean) => void;
  setActiveTab: (tabId: WorktreeRightSidebarTabId) => void;
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

function readActiveTab(): WorktreeRightSidebarTabId {
  try {
    const raw = localStorage.getItem(LS_ACTIVE_TAB);
    if (raw === "all-files" || raw === "changes") {
      return raw;
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB;
}

function writeActiveTab(tabId: WorktreeRightSidebarTabId): void {
  try {
    localStorage.setItem(LS_ACTIVE_TAB, tabId);
  } catch {
    // localStorage unavailable
  }
}

export const useWorktreeRightSidebarStore = create<WorktreeRightSidebarState>(
  (set, get) => ({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    activeTab: readActiveTab(),
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
    openTab(tabId, isMobile) {
      writeActiveTab(tabId);
      if (isMobile) {
        set({ activeTab: tabId, mobileOpen: true });
        return;
      }

      writeDesktopOpen(true);
      set({ activeTab: tabId, desktopOpen: true });
    },
    setActiveTab(tabId) {
      writeActiveTab(tabId);
      set({ activeTab: tabId });
    },
  }),
);

export function resetWorktreeRightSidebarStoreForTests(): void {
  useWorktreeRightSidebarStore.setState({
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    activeTab: readActiveTab(),
  });
}
