import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import TabBar from "@/components/TabBar";
import WorktreeGitSidebar from "@/components/WorktreeGitSidebar";
import { useTabStore } from "@/lib/stores/tabs";
import type { Worktree } from "@/lib/types";
import TerminalTab from "@/components/TerminalTab";

type Props = {
  worktree: Worktree;
};

export default function WorktreeView({ worktree }: Props) {
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

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [switchToWorktree, worktree.id]);

  return (
    <div className="flex h-full overflow-hidden">
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
