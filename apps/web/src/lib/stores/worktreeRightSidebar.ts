import { create } from "zustand";
import {
  DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB,
  WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
  type WorktreeRightSidebarTabId,
} from "@/lib/worktreeRightSidebar";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useWorktreeStore } from "@/lib/stores/worktrees";

const LS_DESKTOP_OPEN = "hubris-worktree-right-sidebar-open";
const LS_LEGACY_DESKTOP_OPEN = "hubris-worktree-git-sidebar-open";
const LS_ACTIVE_TAB = "hubris-worktree-right-sidebar-tab";
const MOBILE_BREAKPOINT = 768;

type WorktreeRightSidebarState = {
  isMobileViewport: boolean;
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

function readIsMobileViewport(): boolean {
  try {
    return window.innerWidth < MOBILE_BREAKPOINT;
  } catch {
    return false;
  }
}

function isSidebarVisible(state: WorktreeRightSidebarState): boolean {
  return state.isMobileViewport ? state.mobileOpen : state.desktopOpen;
}

function selectedWorktree() {
  const state = useWorktreeStore.getState();
  if (!state.selectedWorktreeId) {
    return null;
  }

  return (
    Object.values(state.worktreesByProject)
      .flat()
      .find((worktree) => worktree.id === state.selectedWorktreeId) ?? null
  );
}

let initialized = false;
let storeUnsubscribers: Array<() => void> = [];
let mobileMediaQuery: MediaQueryList | null = null;
let mobileMediaQueryListener: ((event: MediaQueryListEvent) => void) | null =
  null;
let coordinationScheduled = false;
let coordinationRunning = false;
let coordinationReschedule = false;
let lastCoordinationSnapshot: SidebarCoordinationSnapshot | null = null;

type SidebarCoordinationSnapshot = {
  selectedWorktreeId: string | null;
  selectedProjectId: string | null;
  sidebarVisible: boolean;
  activeTab: WorktreeRightSidebarTabId;
  pendingGeneration: number;
  pendingGitGeneration: number;
  rootDirectoryStatus: string | null;
  gitStatusGeneration: number;
};

function scheduleSidebarCoordination(): void {
  if (coordinationRunning) {
    coordinationReschedule = true;
    return;
  }

  if (coordinationScheduled) {
    return;
  }

  coordinationScheduled = true;
  queueMicrotask(() => {
    coordinationScheduled = false;
    void runSidebarCoordination();
  });
}

function readCoordinationSnapshot(): SidebarCoordinationSnapshot {
  const worktree = selectedWorktree();
  const sidebarState = useWorktreeRightSidebarStore.getState();
  const worktreeState = worktree
    ? useWorktreeFileManagerStore.getState().worktrees[worktree.id]
    : undefined;

  return {
    selectedWorktreeId: worktree?.id ?? null,
    selectedProjectId: worktree?.project_id ?? null,
    sidebarVisible: isSidebarVisible(sidebarState),
    activeTab: sidebarState.activeTab,
    pendingGeneration: worktreeState?.pendingGeneration ?? 0,
    pendingGitGeneration: worktreeState?.pendingGitGeneration ?? 0,
    rootDirectoryStatus: worktreeState?.directories[""]?.status ?? null,
    gitStatusGeneration: worktreeState?.gitStatus?.generation ?? 0,
  };
}

function coordinationSnapshotChanged(
  previous: SidebarCoordinationSnapshot | null,
  next: SidebarCoordinationSnapshot,
): boolean {
  return (
    previous?.selectedWorktreeId !== next.selectedWorktreeId ||
    previous?.selectedProjectId !== next.selectedProjectId ||
    previous?.sidebarVisible !== next.sidebarVisible ||
    previous?.activeTab !== next.activeTab ||
    previous?.pendingGeneration !== next.pendingGeneration ||
    previous?.pendingGitGeneration !== next.pendingGitGeneration ||
    previous?.rootDirectoryStatus !== next.rootDirectoryStatus ||
    previous?.gitStatusGeneration !== next.gitStatusGeneration
  );
}

function handleCoordinationSourceChange(): void {
  const nextSnapshot = readCoordinationSnapshot();
  if (!coordinationSnapshotChanged(lastCoordinationSnapshot, nextSnapshot)) {
    return;
  }
  lastCoordinationSnapshot = nextSnapshot;
  scheduleSidebarCoordination();
}

async function runSidebarCoordination(): Promise<void> {
  if (coordinationRunning) {
    coordinationReschedule = true;
    return;
  }

  coordinationRunning = true;

  try {
    do {
      coordinationReschedule = false;

      const worktree = selectedWorktree();
      if (!worktree) {
        continue;
      }

      const sidebarState = useWorktreeRightSidebarStore.getState();
      if (!isSidebarVisible(sidebarState)) {
        continue;
      }

      const fileManager = useWorktreeFileManagerStore.getState();
      const worktreeState = fileManager.worktrees[worktree.id];
      const pendingGeneration = worktreeState?.pendingGeneration ?? 0;
      const pendingGitGeneration = worktreeState?.pendingGitGeneration ?? 0;

      if (pendingGeneration > 0) {
        await fileManager.refreshPendingPaths(worktree.project_id, worktree.id);
        continue;
      }

      if (pendingGitGeneration > 0) {
        await fileManager.loadGitStatus(worktree.project_id, worktree.id, {
          force: true,
        });
        continue;
      }

      if (sidebarState.activeTab === WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB) {
        await fileManager.loadDirectory(worktree.project_id, worktree.id, "");
        await Promise.all([
          fileManager.loadGitStatus(worktree.project_id, worktree.id),
          fileManager.preloadVisibleDirectories(
            worktree.project_id,
            worktree.id,
          ),
        ]);
        continue;
      }

      await fileManager.loadGitStatus(worktree.project_id, worktree.id);
    } while (coordinationReschedule);
  } finally {
    coordinationRunning = false;
    if (coordinationReschedule) {
      scheduleSidebarCoordination();
    }
  }
}

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
    isMobileViewport: readIsMobileViewport(),
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

export function initializeWorktreeRightSidebarStore(): void {
  if (initialized) return;
  initialized = true;

  if (typeof window.matchMedia === "function") {
    mobileMediaQuery = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
    );
    mobileMediaQueryListener = (event) => {
      useWorktreeRightSidebarStore.setState({
        isMobileViewport: event.matches,
      });
    };
    mobileMediaQuery.addEventListener("change", mobileMediaQueryListener);
    useWorktreeRightSidebarStore.setState({
      isMobileViewport: mobileMediaQuery.matches,
    });
  }

  storeUnsubscribers = [
    useWorktreeRightSidebarStore.subscribe(handleCoordinationSourceChange),
    useWorktreeStore.subscribe(handleCoordinationSourceChange),
    useWorktreeFileManagerStore.subscribe(handleCoordinationSourceChange),
  ];

  handleCoordinationSourceChange();
}

export function resetWorktreeRightSidebarStoreForTests(): void {
  initialized = false;
  for (const unsubscribe of storeUnsubscribers) {
    unsubscribe();
  }
  storeUnsubscribers = [];
  if (mobileMediaQuery && mobileMediaQueryListener) {
    mobileMediaQuery.removeEventListener("change", mobileMediaQueryListener);
  }
  mobileMediaQuery = null;
  mobileMediaQueryListener = null;
  coordinationScheduled = false;
  coordinationRunning = false;
  coordinationReschedule = false;
  lastCoordinationSnapshot = null;
  useWorktreeRightSidebarStore.setState({
    isMobileViewport: readIsMobileViewport(),
    desktopOpen: readDesktopOpen(),
    mobileOpen: false,
    activeTab: readActiveTab(),
  });
}
