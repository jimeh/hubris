import { useEffect, useMemo } from "react";
import { TabBar } from "./TabBar";
import { TerminalTab } from "./TerminalTab";
import { useTabStore } from "@/lib/stores/tabs";
import type { Worktree } from "@/lib/types";

interface WorktreeViewProps {
  worktree: Worktree;
}

export function WorktreeView({ worktree }: WorktreeViewProps) {
  const tabs = useTabStore((s) => s.tabs);
  const worktreeTabs = useMemo(
    () => tabs.filter((t) => t.worktree_id === worktree.id),
    [tabs, worktree.id],
  );
  const activeTabId = useTabStore((s) => s.activeTabId);
  const switchToWorktree = useTabStore((s) => s.switchToWorktree);
  const activate = useTabStore((s) => s.activate);
  const close = useTabStore((s) => s.close);
  const removeLocal = useTabStore((s) => s.removeLocal);
  const addTerminal = useTabStore((s) => s.addTerminal);

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [worktree.id, switchToWorktree]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TabBar
        worktreeId={worktree.id}
        tabs={worktreeTabs}
        activeTabId={activeTabId}
        onActivate={activate}
        onClose={close}
        onAdd={() => addTerminal(worktree.id)}
      />

      <div className="relative flex-1 overflow-hidden">
        {worktreeTabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${
              tab.id !== activeTabId ? "hidden" : ""
            }`}
          >
            {tab.type === "terminal" && (
              <TerminalTab
                tabId={tab.id}
                visible={tab.id === activeTabId}
                onClosed={() => removeLocal(tab.id)}
              />
            )}
          </div>
        ))}
        {worktreeTabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Click + to open a terminal</p>
          </div>
        )}
      </div>
    </div>
  );
}
