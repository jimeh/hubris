import { useEffect, useMemo } from "react";
import TabBar from "@/components/TabBar";
import { useTabStore } from "$lib/stores/tabs";
import type { Worktree } from "$lib/types";
import TerminalTab from "@/components/TerminalTab";

type Props = {
  worktree: Worktree;
};

export default function WorktreeView({ worktree }: Props) {
  const allTabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const switchToWorktree = useTabStore((state) => state.switchToWorktree);
  const addTerminal = useTabStore((state) => state.addTerminal);
  const reorder = useTabStore((state) => state.reorder);
  const activate = useTabStore((state) => state.activate);
  const close = useTabStore((state) => state.close);
  const removeLocal = useTabStore((state) => state.removeLocal);

  const worktreeTabs = useMemo(
    () => allTabs.filter((tab) => tab.worktree_id === worktree.id),
    [allTabs, worktree.id],
  );

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [switchToWorktree, worktree.id]);

  return (
    <div className="flex h-full flex-col">
      <TabBar
        worktreeId={worktree.id}
        tabs={worktreeTabs}
        activeTabId={activeTabId}
        onActivate={activate}
        onClose={(tabId) => void close(tabId)}
        onAdd={() => void addTerminal(worktree.id)}
        onReorder={(orderedIds) => reorder(worktree.id, orderedIds)}
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
                onClosed={() => removeLocal(tab.id)}
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
  );
}
