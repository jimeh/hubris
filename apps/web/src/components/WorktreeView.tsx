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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
  registerViewport: (paneId: string, element: HTMLDivElement | null) => void;
  emptyState: ReactNode;
};

type ViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PaneViewportProps = {
  paneId: string;
  dragging: boolean;
  hasTabs: boolean;
  emptyState: ReactNode;
  registerViewport: (paneId: string, element: HTMLDivElement | null) => void;
};

function paneDropTargetId(
  paneId: string,
  placement: PaneDropPlacement,
): string {
  return `pane-drop:${paneId}:${placement}`;
}

function paneTabBarDropTargetId(paneId: string): string {
  return `pane-tab-bar:${paneId}`;
}

function parsePaneDropTargetId(
  value: string | number,
): { paneId: string; placement: PaneDropPlacement } | null {
  const tabBarParts = String(value).split(":");
  if (tabBarParts.length === 2 && tabBarParts[0] === "pane-tab-bar") {
    return {
      paneId: tabBarParts[1],
      placement: "center",
    };
  }

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

function PaneViewport({
  paneId,
  dragging,
  hasTabs,
  emptyState,
  registerViewport,
}: PaneViewportProps) {
  const setViewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      registerViewport(paneId, element);
    },
    [paneId, registerViewport],
  );

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={setViewportRef}
        className="absolute inset-0 overflow-hidden"
        data-pane-viewport={paneId}
      >
        {!hasTabs ? emptyState : null}
      </div>
      <PaneDropTargets paneId={paneId} visible={dragging} />
    </div>
  );
}

function viewportRectsEqual(
  left: Record<string, ViewportRect>,
  right: Record<string, ViewportRect>,
): boolean {
  const paneIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const paneId of paneIds) {
    const a = left[paneId];
    const b = right[paneId];
    if (
      !a ||
      !b ||
      a.left !== b.left ||
      a.top !== b.top ||
      a.width !== b.width ||
      a.height !== b.height
    ) {
      return false;
    }
  }

  return true;
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
  registerViewport,
  emptyState,
}: PaneLeafProps) {
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        focused && "ring-1 ring-inset ring-primary/40",
      )}
      data-pane-id={paneId}
      onMouseDown={onFocusPane}
    >
      <TabBar
        worktreeId={worktree.id}
        paneId={paneId}
        dropTargetId={paneTabBarDropTargetId(paneId)}
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

      <PaneViewport
        paneId={paneId}
        dragging={dragging}
        hasTabs={paneTabs.length > 0}
        emptyState={emptyState}
        registerViewport={registerViewport}
      />
    </div>
  );
}

function PaneTreeView({
  node,
  renderLeaf,
  onResizeSplit,
}: {
  node: PaneTree;
  renderLeaf: (paneId: string) => ReactNode;
  onResizeSplit: (nodeId: string, ratio: number) => void;
}) {
  if (node.type === "leaf") {
    return <>{renderLeaf(node.paneId)}</>;
  }

  const orientation = node.axis === "vertical" ? "horizontal" : "vertical";

  return (
    <ResizablePanelGroup
      orientation={orientation}
      className="min-h-0 min-w-0 flex-1 overflow-hidden"
      onLayoutChanged={(layout) => {
        const nextRatio = layout[`${node.id}:first`] / 100;
        if (Number.isFinite(nextRatio)) {
          onResizeSplit(node.id, nextRatio);
        }
      }}
    >
      <ResizablePanel
        id={`${node.id}:first`}
        defaultSize={node.ratio * 100}
        minSize={15}
      >
        <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
          <PaneTreeView
            node={node.first}
            renderLeaf={renderLeaf}
            onResizeSplit={onResizeSplit}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id={`${node.id}:second`}
        defaultSize={(1 - node.ratio) * 100}
        minSize={15}
      >
        <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
          <PaneTreeView
            node={node.second}
            renderLeaf={renderLeaf}
            onResizeSplit={onResizeSplit}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default function WorktreeView({ worktree, active }: Props) {
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [isPendingCloseSaving, setIsPendingCloseSaving] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [paneViewportRects, setPaneViewportRects] = useState<
    Record<string, ViewportRect>
  >({});
  const isRightSidebarResizing = useWorktreeRightSidebarWidthStore(
    (state) => state.isResizing,
  );
  const initialRightSidebarWidthRef = useRef(
    useWorktreeRightSidebarWidthStore.getState().width,
  );
  const layoutPersistTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const viewRef = useRef<HTMLDivElement | null>(null);
  const paneSceneLayerRef = useRef<HTMLDivElement | null>(null);
  const paneViewportObserverRef = useRef<ResizeObserver | null>(null);
  const paneViewportElementsRef = useRef(new Map<string, HTMLDivElement>());
  const lastVisibleSceneRectsRef = useRef<Record<string, ViewportRect>>({});
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
    setSplitRatio,
    persistLayout,
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
      setSplitRatio: state.setSplitRatio,
      persistLayout: state.persistLayout,
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
  const activeWorktreeTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, worktreeTabs],
  );
  const activePaneTabIds = useMemo(
    () =>
      Object.fromEntries(
        Array.from(
          new Set([
            ...Object.keys(paneTabsById),
            ...Object.keys(activeTabByPane),
            activeWorktreeTab?.pane_id ?? "",
          ]),
        )
          .filter(Boolean)
          .map((paneId) => [
            paneId,
            activeTabByPane[paneId] ??
              (activeWorktreeTab?.pane_id === paneId
                ? activeWorktreeTab.id
                : null),
          ]),
      ) as Record<string, string | null>,
    [activeTabByPane, activeWorktreeTab, paneTabsById],
  );
  const focusedPaneId =
    focusedPaneByWorktree[worktree.id] ??
    (paneTree?.type === "leaf" ? paneTree.paneId : worktreeTabs[0]?.pane_id);
  const pendingCloseTab = useMemo(
    () => worktreeTabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, worktreeTabs],
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

  const recalculatePaneViewportRects = useCallback(() => {
    const layer = paneSceneLayerRef.current;
    if (!layer) {
      return;
    }

    const layerRect = layer.getBoundingClientRect();
    const nextRects: Record<string, ViewportRect> = {};

    for (const [paneId, element] of paneViewportElementsRef.current) {
      if (!element.isConnected) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      nextRects[paneId] = {
        left: Math.round(rect.left - layerRect.left),
        top: Math.round(rect.top - layerRect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    setPaneViewportRects((current) =>
      viewportRectsEqual(current, nextRects) ? current : nextRects,
    );
  }, []);

  const registerViewport = useCallback(
    (paneId: string, element: HTMLDivElement | null) => {
      const current = paneViewportElementsRef.current.get(paneId);
      if (current === element) {
        return;
      }

      if (current) {
        paneViewportObserverRef.current?.unobserve(current);
        paneViewportElementsRef.current.delete(paneId);
      }

      if (element) {
        paneViewportElementsRef.current.set(paneId, element);
        paneViewportObserverRef.current?.observe(element);
      }

      recalculatePaneViewportRects();
    },
    [recalculatePaneViewportRects],
  );

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      recalculatePaneViewportRects();
    });
    paneViewportObserverRef.current = observer;

    if (paneSceneLayerRef.current) {
      observer.observe(paneSceneLayerRef.current);
    }
    for (const element of paneViewportElementsRef.current.values()) {
      observer.observe(element);
    }

    const handleWindowResize = () => {
      recalculatePaneViewportRects();
    };

    window.addEventListener("resize", handleWindowResize);
    recalculatePaneViewportRects();

    return () => {
      paneViewportObserverRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [recalculatePaneViewportRects]);

  useLayoutEffect(() => {
    recalculatePaneViewportRects();
  }, [paneTree, recalculatePaneViewportRects]);

  useEffect(
    () => () => {
      for (const timer of layoutPersistTimersRef.current.values()) {
        clearTimeout(timer);
      }
      layoutPersistTimersRef.current.clear();
    },
    [],
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
  const handleResizeSplit = useCallback(
    (nodeId: string, ratio: number) => {
      const changed = setSplitRatio(worktree.id, nodeId, ratio);
      if (!changed) {
        return;
      }

      const existingTimer = layoutPersistTimersRef.current.get(nodeId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        layoutPersistTimersRef.current.delete(nodeId);
        void persistLayout(worktree.project_id, worktree.id);
      }, 150);
      layoutPersistTimersRef.current.set(nodeId, timer);
    },
    [persistLayout, setSplitRatio, worktree.id, worktree.project_id],
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
        activePaneTabId={activePaneTabIds[paneId] ?? null}
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
        registerViewport={registerViewport}
        emptyState={emptyState}
      />
    ),
    [
      activePaneTabIds,
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
      lockedTabIds,
      openBrowser,
      paneTabsById,
      registerViewport,
      splitPane,
      worktree,
    ],
  );

  const sceneRectsByTabId = useMemo(() => {
    const nextKnownRects = { ...lastVisibleSceneRectsRef.current };
    const rectsByTabId: Record<string, ViewportRect | null> = {};

    for (const tab of worktreeTabs) {
      const isVisible = active && activePaneTabIds[tab.pane_id] === tab.id;
      if (!isVisible) {
        rectsByTabId[tab.id] = null;
        continue;
      }

      const measuredRect = paneViewportRects[tab.pane_id];
      if (measuredRect) {
        nextKnownRects[tab.id] = measuredRect;
      }
      rectsByTabId[tab.id] = measuredRect ?? nextKnownRects[tab.id] ?? null;
    }

    lastVisibleSceneRectsRef.current = nextKnownRects;
    return rectsByTabId;
  }, [active, activePaneTabIds, paneViewportRects, worktreeTabs]);

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
          <div
            ref={paneSceneLayerRef}
            className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {paneTree ? (
              <PaneTreeView
                node={paneTree}
                renderLeaf={renderLeaf}
                onResizeSplit={handleResizeSplit}
              />
            ) : (
              renderLeaf(worktreeTabs[0]?.pane_id ?? "root")
            )}
            <div className="pointer-events-none absolute inset-0 z-10">
              {worktreeTabs.map((tab) => {
                const rect = sceneRectsByTabId[tab.id];
                const visible =
                  rect !== null &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  activePaneTabIds[tab.pane_id] === tab.id &&
                  active;

                return (
                  <div
                    key={tab.id}
                    className={cn(
                      "absolute overflow-hidden bg-background",
                      visible ? "pointer-events-auto" : "hidden",
                    )}
                    style={
                      rect
                        ? {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height,
                          }
                        : undefined
                    }
                  >
                    {tab.type === "terminal" ? (
                      <TerminalTab
                        tabId={tab.id}
                        visible={visible}
                        onClosed={handleTabClosed}
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
            </div>
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
