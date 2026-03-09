import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import TabBar from "@/components/TabBar";
import WorktreeGitSidebar from "@/components/WorktreeGitSidebar";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeGitSidebarWidthStore } from "@/lib/stores/worktreeGitSidebarWidth";
import type { Worktree } from "@/lib/types";
import TerminalTab from "@/components/TerminalTab";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
};

export default function WorktreeView({ worktree }: Props) {
  const isGitSidebarResizing = useWorktreeGitSidebarWidthStore(
    (state) => state.isResizing,
  );
  const activeTabId = useTabStore((state) => state.activeTabId);
  const switchToWorktree = useTabStore((state) => state.switchToWorktree);
  const addTerminal = useTabStore((state) => state.addTerminal);
  const reorder = useTabStore((state) => state.reorder);
  const activate = useTabStore((state) => state.activate);
  const close = useTabStore((state) => state.close);
  const removeLocal = useTabStore((state) => state.removeLocal);
  const worktreeTabs = useTabStore(
    useShallow((state) =>
      state.tabs.filter((tab) => tab.worktree_id === worktree.id),
    ),
  );
  const handleTabClosed = useCallback(
    (tabId: string) => {
      removeLocal(tabId);
    },
    [removeLocal],
  );
  const handleActivateTab = useCallback(
    (tabId: string) => {
      activate(tabId);
    },
    [activate],
  );
  const handleCloseTab = useCallback(
    (tabId: string) => {
      void close(tabId);
    },
    [close],
  );
  const handleAddTab = useCallback(() => {
    void addTerminal(worktree.id);
  }, [addTerminal, worktree.id]);
  const handleReorderTabs = useCallback(
    (orderedIds: string[]) => reorder(worktree.id, orderedIds),
    [reorder, worktree.id],
  );
  const viewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [switchToWorktree, worktree.id]);

  useLayoutEffect(() => {
    const host =
      viewRef.current?.querySelector<HTMLElement>(
        "[data-worktree-git-sidebar-wrapper]",
      ) ?? null;
    if (!host) {
      return;
    }
    const sidebarHost = host;

    function applyWidth(width: number): void {
      sidebarHost.style.setProperty(
        "--worktree-git-sidebar-width",
        `${width}px`,
      );
    }

    applyWidth(useWorktreeGitSidebarWidthStore.getState().width);

    return useWorktreeGitSidebarWidthStore.subscribe((state) => {
      applyWidth(state.width);
    });
  }, []);

  return (
    <div
      ref={viewRef}
      className={cn(
        "flex h-full overflow-hidden",
        isGitSidebarResizing && "worktree-git-sidebar-resizing",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          worktreeId={worktree.id}
          tabs={worktreeTabs}
          activeTabId={activeTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onAdd={handleAddTab}
          onReorder={handleReorderTabs}
        />

        <div className="relative flex-1 overflow-hidden">
          {worktreeTabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeTabId ? "absolute inset-0" : "hidden"}
            >
              {tab.type === "terminal" ? (
                <TerminalTab
                  tabId={tab.id}
                  visible={tab.id === activeTabId}
                  onClosed={handleTabClosed}
                />
              ) : null}
            </div>
          ))}

          {worktreeTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p>Click + to open a terminal</p>
            </div>
          ) : null}
        </div>
      </div>

      <WorktreeGitSidebar worktree={worktree} />
    </div>
  );
}
