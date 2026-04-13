import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import BrowserTab from "@/components/BrowserTab";
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
import { useGitDiffStore } from "@/lib/stores/gitDiffTabs";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useWorktreeRightSidebarWidthStore } from "@/lib/stores/worktreeRightSidebarWidth";
import { buildPaneTree, createSinglePaneLayout } from "@/lib/tabLayout";
import type { PaneDropPlacement, PaneTree } from "@/lib/tabLayout";
import type { Tab, Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
  active: boolean;
};

type PaneDropTargetProps = {
  paneId: string;
  placement: PaneDropPlacement;
  className: string;
  label: string;
};

type PaneLeafProps = {
  worktree: Worktree;
  paneId: string;
  paneTabs: Tab[];
  activePaneTabId: string | null;
  focused: boolean;
  dragging: boolean;
  dirtyTabIds: string[];
  lockedTabIds: string[];
  onActivateTab: (tabId: string) => void;
  onPinTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTerminal: () => void;
  onAddBrowser: () => Promise<void>;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onRenameTerminalTab: (tabId: string, label: string) => Promise<void>;
  onResetTerminalTabName: (tabId: string) => Promise<void>;
  onFocusPane: () => void;
  onTabClosed: (tabId: string) => void;
  emptyState: ReactNode;
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

function paneDropTargetId(
  paneId: string,
  placement: PaneDropPlacement,
): string {
  return `pane-drop:${paneId}:${placement}`;
}

function parsePaneDropTargetId(
  value: string | number,
): { paneId: string; placement: PaneDropPlacement } | null {
  const parts = String(value).split(":");
  if (parts.length !== 3 || parts[0] !== "pane-drop") {
    return null;
  }

  const placement = parts[2] as PaneDropPlacement;
  if (
    placement !== "center" &&
    placement !== "left" &&
    placement !== "right" &&
    placement !== "top" &&
    placement !== "bottom"
  ) {
    return null;
  }

  return {
    paneId: parts[1],
    placement,
  };
}

function PaneDropTarget({
  paneId,
  placement,
  className,
  label,
}: PaneDropTargetProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropTargetId(paneId, placement),
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute rounded-md border border-dashed border-transparent transition-colors",
        "bg-transparent",
        isOver && "border-primary/70 bg-primary/12",
        className,
      )}
      data-pane-drop-target={placement}
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-0 hidden items-center justify-center text-[11px] font-medium text-muted-foreground",
          isOver && "flex text-primary",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function PaneDropTargets({
  paneId,
  visible,
}: {
  paneId: string;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-2 z-20">
      <PaneDropTarget
        paneId={paneId}
        placement="left"
        label="Split Left"
        className="pointer-events-auto inset-y-0 left-0 w-[24%]"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="right"
        label="Split Right"
        className="pointer-events-auto inset-y-0 right-0 w-[24%]"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="top"
        label="Split Up"
        className="pointer-events-auto inset-x-0 top-0 h-[24%]"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="bottom"
        label="Split Down"
        className="pointer-events-auto inset-x-0 bottom-0 h-[24%]"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="center"
        label="Move Tab"
        className="pointer-events-auto inset-[24%]"
      />
    </div>
  );
}

function PaneLeaf({
  worktree,
  paneId,
  paneTabs,
  activePaneTabId,
  focused,
  dragging,
  dirtyTabIds,
  lockedTabIds,
  onActivateTab,
  onPinTab,
  onCloseTab,
  onAddTerminal,
  onAddBrowser,
  onSplitRight,
  onSplitDown,
  onRenameTerminalTab,
  onResetTerminalTabName,
  onFocusPane,
  onTabClosed,
  emptyState,
}: PaneLeafProps) {
  const panelTabs = useMemo(
    () => [...paneTabs].sort(comparePanelOrder),
    [paneTabs],
  );

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        focused && "ring-1 ring-inset ring-primary/40",
      )}
      data-pane-id={paneId}
      onMouseDown={onFocusPane}
    >
      <TabBar
        worktreeId={worktree.id}
        paneId={paneId}
        tabs={paneTabs}
        dirtyTabIds={dirtyTabIds}
        lockedTabIds={lockedTabIds}
        activeTabId={activePaneTabId}
        onActivate={onActivateTab}
        onPin={onPinTab}
        onClose={onCloseTab}
        onAddTerminal={onAddTerminal}
        onAddBrowser={onAddBrowser}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onRenameTerminalTab={onRenameTerminalTab}
        onResetTerminalTabName={onResetTerminalTabName}
        dragging={dragging}
      />

      <div className="relative flex-1 overflow-hidden">
        {panelTabs.map((tab) => {
          const visible = tab.id === activePaneTabId;
          return (
            <div
              key={tab.id}
              className={visible ? "absolute inset-0" : "hidden"}
            >
              {tab.type === "terminal" ? (
                <TerminalTab
                  tabId={tab.id}
                  visible={visible}
                  onClosed={onTabClosed}
                />
              ) : tab.type === "file" ? (
                <FileEditorTab
                  projectId={worktree.project_id}
                  worktreeId={worktree.id}
                  tab={tab}
                  visible={visible}
                />
              ) : tab.type === "git_diff" ? (
                <GitDiffTab
                  projectId={worktree.project_id}
                  worktreeId={worktree.id}
                  tab={tab}
                  visible={visible}
                />
              ) : tab.type === "browser" ? (
                <BrowserTab tab={tab} visible={visible} />
              ) : null}
            </div>
          );
        })}

        {paneTabs.length === 0 ? emptyState : null}
        <PaneDropTargets paneId={paneId} visible={dragging} />
      </div>
    </div>
  );
}

function PaneTreeView({
  node,
  renderLeaf,
}: {
  node: PaneTree;
  renderLeaf: (paneId: string) => ReactNode;
}) {
  if (node.type === "leaf") {
    return <>{renderLeaf(node.paneId)}</>;
  }

  const firstBasis = `${Math.round(node.ratio * 10000) / 100}%`;
  const secondBasis = `${Math.round((1 - node.ratio) * 10000) / 100}%`;
  const horizontal = node.axis === "vertical";

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden",
        horizontal ? "flex-row" : "flex-col",
      )}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: firstBasis, flexGrow: 1, flexShrink: 1 }}
      >
        <PaneTreeView node={node.first} renderLeaf={renderLeaf} />
      </div>
      <div className={horizontal ? "w-px bg-border" : "h-px bg-border"} />
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: secondBasis, flexGrow: 1, flexShrink: 1 }}
      >
        <PaneTreeView node={node.second} renderLeaf={renderLeaf} />
      </div>
    </div>
  );
}

export default function WorktreeView({ worktree, active }: Props) {
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [isPendingCloseSaving, setIsPendingCloseSaving] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const isRightSidebarResizing = useWorktreeRightSidebarWidthStore(
    (state) => state.isResizing,
  );
  const initialRightSidebarWidthRef = useRef(
    useWorktreeRightSidebarWidthStore.getState().width,
  );
  const viewRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const {
    activeTabId,
    activeTabByPane,
    focusedPaneByWorktree,
    layoutsByWorktree,
    addTerminal,
    reorder,
    activate,
    close,
    pin,
    moveTab,
    splitPane,
    focusPane,
    setTerminalCustomLabel,
    resetTerminalCustomLabel,
    openBrowser,
    removeLocal,
  } = useTabStore(
    useShallow((state) => ({
      activeTabId: state.activeTabId,
      activeTabByPane: state.activeTabByPane,
      focusedPaneByWorktree: state.focusedPaneByWorktree,
      layoutsByWorktree: state.layoutsByWorktree,
      addTerminal: state.addTerminal,
      reorder: state.reorder,
      activate: state.activate,
      close: state.close,
      pin: state.pin,
      moveTab: state.moveTab,
      splitPane: state.splitPane,
      focusPane: state.focusPane,
      setTerminalCustomLabel: state.setTerminalCustomLabel,
      resetTerminalCustomLabel: state.resetTerminalCustomLabel,
      openBrowser: state.openBrowser,
      removeLocal: state.removeLocal,
    })),
  );
  const saveFile = useFileEditorStore((state) => state.save);
  const saveDiff = useGitDiffStore((state) => state.save);
  const dirtyFileTabIds = useFileEditorStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((session) => session.dirty)
        .map((session) => session.tabId),
    ),
  );
  const dirtyGitDiffTabIds = useGitDiffStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((session) => session.dirty)
        .map((session) => session.tabId),
    ),
  );
  const lockedFileTabIds = useFileEditorStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter(
          (session) => session.loadStatus === "loaded" && session.readOnly,
        )
        .map((session) => session.tabId),
    ),
  );
  const lockedGitDiffTabIds = useGitDiffStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter(
          (session) => session.loadStatus === "loaded" && session.readOnly,
        )
        .map((session) => session.tabId),
    ),
  );
  const dirtyTabIds = useMemo(
    () => [...dirtyFileTabIds, ...dirtyGitDiffTabIds],
    [dirtyFileTabIds, dirtyGitDiffTabIds],
  );
  const lockedTabIds = useMemo(
    () => [...lockedFileTabIds, ...lockedGitDiffTabIds],
    [lockedFileTabIds, lockedGitDiffTabIds],
  );
  const setSelectedPath = useWorktreeFileManagerStore(
    (state) => state.setSelectedPath,
  );
  const worktreeTabs = useTabStore(
    useShallow((state) =>
      state.tabs.filter((tab) => tab.worktree_id === worktree.id),
    ),
  );
  const layout = useMemo(
    () =>
      layoutsByWorktree[worktree.id] ??
      createSinglePaneLayout(worktreeTabs[0]?.pane_id),
    [layoutsByWorktree, worktree.id, worktreeTabs],
  );
  const paneTree = useMemo(() => buildPaneTree(layout), [layout]);
  const paneTabsById = useMemo(
    () =>
      Object.fromEntries(
        Array.from(new Set(worktreeTabs.map((tab) => tab.pane_id))).map(
          (paneId) => [
            paneId,
            worktreeTabs
              .filter((tab) => tab.pane_id === paneId)
              .sort((left, right) => left.position - right.position),
          ],
        ),
      ) as Record<string, Tab[]>,
    [worktreeTabs],
  );
  const focusedPaneId =
    focusedPaneByWorktree[worktree.id] ??
    (paneTree?.type === "leaf" ? paneTree.paneId : worktreeTabs[0]?.pane_id);
  const pendingCloseTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, worktreeTabs],
  );
  const activeWorktreeTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, worktreeTabs],
  );
  const emptyState = useMemo(
    () => (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>
          Use the terminal or browser buttons to open a tab, or select a file to
          preview.
        </p>
      </div>
    ),
    [],
  );

  useEffect(() => {
    if (!activeWorktreeTab || activeWorktreeTab.worktree_id !== worktree.id) {
      return;
    }

    if (
      activeWorktreeTab.type === "file" ||
      activeWorktreeTab.type === "git_diff"
    ) {
      setSelectedPath(worktree.id, activeWorktreeTab.path);
    }
  }, [activeWorktreeTab, setSelectedPath, worktree.id]);

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
      setIsPendingCloseSaving(false);
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
      const isDirty =
        useFileEditorStore.getState().sessions[tabId]?.dirty ||
        useGitDiffStore.getState().sessions[tabId]?.dirty;
      if ((tab?.type === "file" || tab?.type === "git_diff") && isDirty) {
        setPendingCloseTabId(tabId);
        return;
      }

      void close(tabId);
    },
    [close],
  );
  const handleRenameTerminalTab = useCallback(
    async (tabId: string, label: string) => {
      await setTerminalCustomLabel(tabId, label);
    },
    [setTerminalCustomLabel],
  );
  const handleResetTerminalTabName = useCallback(
    async (tabId: string) => {
      await resetTerminalCustomLabel(tabId);
    },
    [resetTerminalCustomLabel],
  );

  function clearDragState(): void {
    setDraggingTabId(null);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDraggingTabId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    const draggedTabId = String(event.active.id);
    const overId = event.over?.id;
    clearDragState();

    if (!overId || overId === draggedTabId) {
      return;
    }

    const activeTab = worktreeTabs.find((tab) => tab.id === draggedTabId);
    if (!activeTab) {
      return;
    }

    const dropTarget = parsePaneDropTargetId(overId);
    if (dropTarget) {
      void moveTab(
        worktree.project_id,
        worktree.id,
        draggedTabId,
        dropTarget.paneId,
        dropTarget.placement,
      );
      return;
    }

    const overTab = worktreeTabs.find((tab) => tab.id === overId);
    if (!overTab) {
      return;
    }

    if (overTab.pane_id === activeTab.pane_id) {
      const paneTabs = paneTabsById[activeTab.pane_id] ?? [];
      const oldIndex = paneTabs.findIndex((tab) => tab.id === draggedTabId);
      const newIndex = paneTabs.findIndex((tab) => tab.id === overTab.id);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
        return;
      }
      const nextTabs = arrayMove(paneTabs, oldIndex, newIndex);
      void reorder(
        worktree.id,
        activeTab.pane_id,
        nextTabs.map((tab) => tab.id),
      );
      return;
    }

    void moveTab(
      worktree.project_id,
      worktree.id,
      draggedTabId,
      overTab.pane_id,
      "center",
      overTab.id,
    );
  }

  const renderLeaf = useCallback(
    (paneId: string) => (
      <PaneLeaf
        key={paneId}
        worktree={worktree}
        paneId={paneId}
        paneTabs={paneTabsById[paneId] ?? []}
        activePaneTabId={
          activeTabByPane[paneId] ??
          (activeWorktreeTab?.pane_id === paneId ? activeWorktreeTab.id : null)
        }
        focused={focusedPaneId === paneId}
        dragging={draggingTabId !== null}
        dirtyTabIds={dirtyTabIds}
        lockedTabIds={lockedTabIds}
        onActivateTab={handleActivateTab}
        onPinTab={handlePinTab}
        onCloseTab={handleCloseTab}
        onAddTerminal={() => {
          void addTerminal(worktree.id, paneId);
        }}
        onAddBrowser={async () => {
          await openBrowser({ worktreeId: worktree.id, paneId });
        }}
        onSplitRight={() => {
          void splitPane(worktree.project_id, worktree.id, paneId, "right");
        }}
        onSplitDown={() => {
          void splitPane(worktree.project_id, worktree.id, paneId, "down");
        }}
        onRenameTerminalTab={handleRenameTerminalTab}
        onResetTerminalTabName={handleResetTerminalTabName}
        onFocusPane={() => focusPane(worktree.id, paneId)}
        onTabClosed={handleTabClosed}
        emptyState={emptyState}
      />
    ),
    [
      activeWorktreeTab,
      activeTabByPane,
      addTerminal,
      dirtyTabIds,
      draggingTabId,
      emptyState,
      focusPane,
      focusedPaneId,
      handleActivateTab,
      handleCloseTab,
      handlePinTab,
      handleRenameTerminalTab,
      handleResetTerminalTabName,
      handleTabClosed,
      lockedTabIds,
      openBrowser,
      paneTabsById,
      splitPane,
      worktree,
    ],
  );

  return (
    <div
      ref={viewRef}
      data-worktree-view
      data-state={active ? "active" : "inactive"}
      className={cn(
        "absolute inset-0 flex overflow-hidden",
        !active && "invisible pointer-events-none",
        isRightSidebarResizing && "worktree-right-sidebar-resizing",
      )}
      style={
        {
          "--worktree-right-sidebar-width": `${initialRightSidebarWidthRef.current}px`,
        } as CSSProperties
      }
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={clearDragState}
        >
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {paneTree ? (
              <PaneTreeView node={paneTree} renderLeaf={renderLeaf} />
            ) : (
              renderLeaf(worktreeTabs[0]?.pane_id ?? "root")
            )}
          </div>
        </DndContext>
      </div>

      <WorktreeRightSidebar worktree={worktree} active={active} />
      <AlertDialog
        open={active && pendingCloseTabId !== null}
        onOpenChange={(open: boolean) => {
          if (!open && isPendingCloseSaving) {
            return;
          }
          if (!open) {
            setPendingCloseTabId(null);
            setIsPendingCloseSaving(false);
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
            <AlertDialogCancel disabled={isPendingCloseSaving}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isPendingCloseSaving}
              className="bg-muted text-foreground hover:bg-muted/80"
              onClick={() => {
                if (!pendingCloseTabId || isPendingCloseSaving) {
                  return;
                }

                const tabId = pendingCloseTabId;
                setIsPendingCloseSaving(false);
                setPendingCloseTabId(null);
                void close(tabId);
              }}
            >
              Don&apos;t Save
            </AlertDialogAction>
            <AlertDialogAction
              disabled={isPendingCloseSaving}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                if (
                  !pendingCloseTabId ||
                  (pendingCloseTab?.type !== "file" &&
                    pendingCloseTab?.type !== "git_diff") ||
                  isPendingCloseSaving
                ) {
                  return;
                }
                event.preventDefault();
                setIsPendingCloseSaving(true);

                void (async () => {
                  try {
                    if (pendingCloseTab.type === "file") {
                      await saveFile(
                        worktree.project_id,
                        worktree.id,
                        pendingCloseTab.id,
                      );
                    } else {
                      await saveDiff(
                        worktree.project_id,
                        worktree.id,
                        pendingCloseTab.id,
                      );
                    }
                    const stillDirty =
                      pendingCloseTab.type === "file"
                        ? useFileEditorStore.getState().sessions[
                            pendingCloseTab.id
                          ]?.dirty
                        : useGitDiffStore.getState().sessions[
                            pendingCloseTab.id
                          ]?.dirty;
                    if (stillDirty) {
                      setIsPendingCloseSaving(false);
                      return;
                    }
                    setIsPendingCloseSaving(false);
                    setPendingCloseTabId(null);
                    await close(pendingCloseTab.id);
                  } catch {
                    // Leave dialog open so the user can retry or discard.
                    setIsPendingCloseSaving(false);
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

  if (tab.type === "browser") {
    return tab.label || tab.url;
  }

  return tab.path.split("/").filter(Boolean).at(-1) ?? tab.path;
}
