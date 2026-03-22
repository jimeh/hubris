import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useShallow } from "zustand/react/shallow";
import FileEditorTab from "@/components/FileEditorTab";
import GitDiffTab from "@/components/GitDiffTab";
import TabBar from "@/components/TabBar";
import TerminalTab from "@/components/TerminalTab";
import WorktreeRightSidebar from "@/components/WorktreeRightSidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFileEditorStore } from "@/lib/stores/fileEditorTabs";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useWorktreeRightSidebarWidthStore } from "@/lib/stores/worktreeRightSidebarWidth";
import type { Tab, Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
};

function comparePanelOrder(a: Tab, b: Tab): number {
  const left = Number(a.created_at);
  const right = Number(b.created_at);

  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left - right;
  }

  const createdAtComparison = String(a.created_at).localeCompare(
    String(b.created_at),
  );
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return a.id.localeCompare(b.id);
}

export default function WorktreeView({ worktree }: Props) {
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const isRightSidebarResizing = useWorktreeRightSidebarWidthStore(
    (state) => state.isResizing,
  );
  const initialRightSidebarWidthRef = useRef(
    useWorktreeRightSidebarWidthStore.getState().width,
  );
  const activeTabId = useTabStore((state) => state.activeTabId);
  const switchToWorktree = useTabStore((state) => state.switchToWorktree);
  const addTerminal = useTabStore((state) => state.addTerminal);
  const reorder = useTabStore((state) => state.reorder);
  const activate = useTabStore((state) => state.activate);
  const close = useTabStore((state) => state.close);
  const pin = useTabStore((state) => state.pin);
  const removeLocal = useTabStore((state) => state.removeLocal);
  const saveFile = useFileEditorStore((state) => state.save);
  const dirtyTabIds = useFileEditorStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((session) => session.dirty)
        .map((session) => session.tabId),
    ),
  );
  const setSelectedPath = useWorktreeFileManagerStore(
    (state) => state.setSelectedPath,
  );
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
  const handlePinTab = useCallback(
    (tabId: string) => {
      void pin(tabId);
    },
    [pin],
  );
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = useTabStore
        .getState()
        .tabs.find((candidate) => candidate.id === tabId);
      const isDirty = useFileEditorStore.getState().sessions[tabId]?.dirty;
      if (tab?.type === "file" && isDirty) {
        setPendingCloseTabId(tabId);
        return;
      }

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
  const activeTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, worktreeTabs],
  );
  const panelTabs = useMemo(
    () => [...worktreeTabs].sort(comparePanelOrder),
    [worktreeTabs],
  );
  const pendingCloseTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, worktreeTabs],
  );

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [switchToWorktree, worktree.id]);

  useEffect(() => {
    if (!activeTab || activeTab.worktree_id !== worktree.id) {
      return;
    }

    if (activeTab.type === "file" || activeTab.type === "git_diff") {
      setSelectedPath(worktree.id, activeTab.path);
    }
  }, [activeTab, setSelectedPath, worktree.id]);

  useEffect(() => {
    if (dirtyTabIds.length === 0) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [dirtyTabIds]);

  useEffect(() => {
    if (
      pendingCloseTabId !== null &&
      !worktreeTabs.some((tab) => tab.id === pendingCloseTabId)
    ) {
      setPendingCloseTabId(null);
    }
  }, [pendingCloseTabId, worktreeTabs]);

  useLayoutEffect(() => {
    const viewRoot = viewRef.current;
    if (!viewRoot) {
      return;
    }
    const viewRootElement = viewRoot;

    function applyWidth(width: number): void {
      viewRootElement.style.setProperty(
        "--worktree-right-sidebar-width",
        `${width}px`,
      );
    }

    applyWidth(useWorktreeRightSidebarWidthStore.getState().width);

    return useWorktreeRightSidebarWidthStore.subscribe((state) => {
      applyWidth(state.width);
    });
  }, []);

  return (
    <div
      ref={viewRef}
      data-worktree-view
      className={cn(
        "flex h-full overflow-hidden",
        isRightSidebarResizing && "worktree-right-sidebar-resizing",
      )}
      style={
        {
          "--worktree-right-sidebar-width": `${initialRightSidebarWidthRef.current}px`,
        } as CSSProperties
      }
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          worktreeId={worktree.id}
          tabs={worktreeTabs}
          dirtyTabIds={dirtyTabIds}
          activeTabId={activeTabId}
          onActivate={handleActivateTab}
          onPin={handlePinTab}
          onClose={handleCloseTab}
          onAdd={handleAddTab}
          onReorder={handleReorderTabs}
        />

        <div className="relative flex-1 overflow-hidden">
          {panelTabs.map((tab) => (
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
              ) : tab.type === "file" ? (
                <FileEditorTab
                  projectId={worktree.project_id}
                  worktreeId={worktree.id}
                  tab={tab}
                  visible={tab.id === activeTabId}
                />
              ) : tab.type === "git_diff" ? (
                <GitDiffTab
                  projectId={worktree.project_id}
                  worktreeId={worktree.id}
                  tab={tab}
                />
              ) : null}
            </div>
          ))}

          {worktreeTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p>Click + to open a terminal, or select a file to preview.</p>
            </div>
          ) : null}
        </div>
      </div>

      <WorktreeRightSidebar worktree={worktree} />
      <AlertDialog
        open={pendingCloseTabId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCloseTabId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Save changes to {tabTitle(pendingCloseTab)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your edits will be lost if you close this tab without saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-muted text-foreground hover:bg-muted/80"
              onClick={() => {
                if (!pendingCloseTabId) {
                  return;
                }

                const tabId = pendingCloseTabId;
                setPendingCloseTabId(null);
                void close(tabId);
              }}
            >
              Don&apos;t Save
            </AlertDialogAction>
            <AlertDialogAction
              onClick={(event) => {
                if (!pendingCloseTabId || pendingCloseTab?.type !== "file") {
                  return;
                }
                event.preventDefault();

                void (async () => {
                  try {
                    await saveFile(
                      worktree.project_id,
                      worktree.id,
                      pendingCloseTab.id,
                    );
                    setPendingCloseTabId(null);
                    await close(pendingCloseTab.id);
                  } catch {
                    // Leave dialog open so the user can retry or discard.
                  }
                })();
              }}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function tabTitle(tab: Tab | null): string {
  if (!tab || tab.type === "terminal") {
    return tab?.label ?? "this file";
  }

  return tab.path.split("/").filter(Boolean).at(-1) ?? tab.path;
}
