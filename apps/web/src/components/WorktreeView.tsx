import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import BrowserTab from "@/components/BrowserTab";
import FileEditorTab from "@/components/FileEditorTab";
import GitDiffTab from "@/components/GitDiffTab";
import AgentChatTabView from "@/components/AgentChatTab";
import TabBar, { type TabBarAction } from "@/components/TabBar";
import TerminalTab from "@/components/TerminalTab";
import WorktreeRightSidebar from "@/components/WorktreeRightSidebar";
import TabDragOverlay from "@/components/tab-bar/TabDragOverlay";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { executeCommand } from "@/lib/commands";
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
  geometryClassName: string;
  indicatorClassName: string;
};

type PaneLeafProps = {
  worktree: Worktree;
  paneId: string;
  paneTabs: Tab[];
  activePaneTabId: string | null;
  activeTabActions: TabBarAction[];
  focused: boolean;
  dragging: boolean;
  draggingTabId: string | null;
  dragOverId: string | null;
  dirtyTabIds: string[];
  lockedTabIds: string[];
  onActivateTab: (tabId: string) => void;
  onPinTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTerminal: () => void;
  onAddBrowser: () => Promise<void>;
  onAddChat: () => Promise<void>;
  onSplitRight: () => void;
  onSplitDown: () => void;
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

const PARKED_SCENE_STYLE = {
  left: -10_000,
  top: 0,
  width: 1,
  height: 1,
  visibility: "hidden",
} satisfies CSSProperties;

type PaneViewportProps = {
  paneId: string;
  dragging: boolean;
  hasTabs: boolean;
  emptyState: ReactNode;
  registerViewport: (paneId: string, element: HTMLDivElement | null) => void;
};

const DISABLED_GIT_DIFF_TAB_ACTIONS: TabBarAction[] = [
  {
    id: "previous-change",
    icon: ChevronUp,
    label: "Previous Change",
    onClick: () => {},
    disabled: true,
  },
  {
    id: "next-change",
    icon: ChevronDown,
    label: "Next Change",
    onClick: () => {},
    disabled: true,
  },
];

function fallbackTabBarActions(tab: Tab | null): TabBarAction[] {
  if (tab?.type !== "git_diff") {
    return [];
  }

  return DISABLED_GIT_DIFF_TAB_ACTIONS;
}

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
  geometryClassName,
  indicatorClassName,
}: PaneDropTargetProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropTargetId(paneId, placement),
  });

  return (
    <>
      <div
        ref={setNodeRef}
        className={cn(
          "absolute rounded-md border border-dashed border-transparent",
          "pointer-events-auto bg-transparent",
          geometryClassName,
        )}
        data-pane-drop-target={placement}
      />
      <div
        className={cn(
          "pointer-events-none absolute rounded-md border border-dashed",
          "border-transparent bg-transparent transition-colors",
          isOver && "border-primary/70 bg-primary/12",
          indicatorClassName,
        )}
        data-pane-drop-indicator={placement}
      />
    </>
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
        geometryClassName="inset-y-0 left-0 w-[24%]"
        indicatorClassName="inset-y-0 left-0 w-1/2"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="right"
        geometryClassName="inset-y-0 right-0 w-[24%]"
        indicatorClassName="inset-y-0 right-0 w-1/2"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="top"
        geometryClassName="inset-x-0 top-0 h-[24%]"
        indicatorClassName="inset-x-0 top-0 h-1/2"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="bottom"
        geometryClassName="inset-x-0 bottom-0 h-[24%]"
        indicatorClassName="inset-x-0 bottom-0 h-1/2"
      />
      <PaneDropTarget
        paneId={paneId}
        placement="center"
        geometryClassName="inset-[28%]"
        indicatorClassName="inset-0"
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

function byStableSceneOrder(left: Tab, right: Tab): number {
  const createdAtDiff = Number(left.created_at) - Number(right.created_at);
  if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return left.id.localeCompare(right.id);
}

function PaneLeaf({
  worktree,
  paneId,
  paneTabs,
  activePaneTabId,
  activeTabActions,
  focused,
  dragging,
  draggingTabId,
  dragOverId,
  dirtyTabIds,
  lockedTabIds,
  onActivateTab,
  onPinTab,
  onCloseTab,
  onAddTerminal,
  onAddBrowser,
  onAddChat,
  onSplitRight,
  onSplitDown,
  onResetTerminalTabName,
  onFocusPane,
  registerViewport,
  emptyState,
}: PaneLeafProps) {
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-pane-id={paneId}
      onMouseDown={onFocusPane}
    >
      <TabBar
        worktreeId={worktree.id}
        paneId={paneId}
        dropTargetId={paneTabBarDropTargetId(paneId)}
        tabs={paneTabs}
        activeTabActions={activeTabActions}
        paneFocused={focused}
        dirtyTabIds={dirtyTabIds}
        lockedTabIds={lockedTabIds}
        activeTabId={activePaneTabId}
        onActivate={onActivateTab}
        onPin={onPinTab}
        onClose={onCloseTab}
        onAddTerminal={onAddTerminal}
        onAddBrowser={onAddBrowser}
        onAddChat={onAddChat}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onResetTerminalTabName={onResetTerminalTabName}
        dragging={dragging}
        draggingTabId={draggingTabId}
        dragOverId={dragOverId}
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
      <ResizableHandle
        className={cn(
          "z-20 -mx-1 w-2 cursor-col-resize touch-none bg-transparent",
          "after:w-px after:bg-border/80 hover:after:bg-border",
          "focus-visible:after:bg-border",
          "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
          "aria-[orientation=horizontal]:cursor-row-resize",
          "aria-[orientation=horizontal]:after:top-0",
          "aria-[orientation=horizontal]:after:bottom-auto",
          "aria-[orientation=horizontal]:after:h-px",
          "aria-[orientation=horizontal]:after:translate-y-0",
        )}
      />
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
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingTabWidth, setDraggingTabWidth] = useState<number | null>(null);
  const [tabBarActionsByTabId, setTabBarActionsByTabId] = useState<
    Record<string, TabBarAction[]>
  >({});
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
  const paneViewportRecalcFrameRef = useRef<number | null>(null);
  const paneViewportRecalcFrameAfterPaintRef = useRef<number | null>(null);
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
    reorder,
    activate,
    moveTab,
    focusPane,
    setSplitRatio,
    persistLayout,
    openAgentChat,
    removeLocal,
  } = useTabStore(
    useShallow((state) => ({
      activeTabId: state.activeTabId,
      activeTabByPane: state.activeTabByPane,
      focusedPaneByWorktree: state.focusedPaneByWorktree,
      layoutsByWorktree: state.layoutsByWorktree,
      reorder: state.reorder,
      activate: state.activate,
      moveTab: state.moveTab,
      focusPane: state.focusPane,
      setSplitRatio: state.setSplitRatio,
      persistLayout: state.persistLayout,
      openAgentChat: state.openAgentChat,
      removeLocal: state.removeLocal,
    })),
  );
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
  const sceneTabs = useMemo(
    () => [...worktreeTabs].sort(byStableSceneOrder),
    [worktreeTabs],
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

  const schedulePaneViewportRecalc = useCallback(() => {
    recalculatePaneViewportRects();

    if (paneViewportRecalcFrameRef.current !== null) {
      cancelAnimationFrame(paneViewportRecalcFrameRef.current);
    }
    if (paneViewportRecalcFrameAfterPaintRef.current !== null) {
      cancelAnimationFrame(paneViewportRecalcFrameAfterPaintRef.current);
    }

    paneViewportRecalcFrameRef.current = requestAnimationFrame(() => {
      paneViewportRecalcFrameRef.current = null;
      recalculatePaneViewportRects();
      paneViewportRecalcFrameAfterPaintRef.current = requestAnimationFrame(
        () => {
          paneViewportRecalcFrameAfterPaintRef.current = null;
          recalculatePaneViewportRects();
        },
      );
    });
  }, [recalculatePaneViewportRects]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      schedulePaneViewportRecalc();
    });
    paneViewportObserverRef.current = observer;

    if (paneSceneLayerRef.current) {
      observer.observe(paneSceneLayerRef.current);
    }
    for (const element of paneViewportElementsRef.current.values()) {
      observer.observe(element);
    }

    const handleWindowResize = () => {
      schedulePaneViewportRecalc();
    };

    window.addEventListener("resize", handleWindowResize);
    schedulePaneViewportRecalc();

    return () => {
      paneViewportObserverRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      if (paneViewportRecalcFrameRef.current !== null) {
        cancelAnimationFrame(paneViewportRecalcFrameRef.current);
        paneViewportRecalcFrameRef.current = null;
      }
      if (paneViewportRecalcFrameAfterPaintRef.current !== null) {
        cancelAnimationFrame(paneViewportRecalcFrameAfterPaintRef.current);
        paneViewportRecalcFrameAfterPaintRef.current = null;
      }
    };
  }, [schedulePaneViewportRecalc]);

  useLayoutEffect(() => {
    schedulePaneViewportRecalc();
  }, [
    active,
    activePaneTabIds,
    paneTree,
    schedulePaneViewportRecalc,
    worktreeTabs.length,
  ]);

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
  const handlePinTab = useCallback((tabId: string) => {
    void executeCommand({
      args: { tabId },
      id: "tab.pin",
      source: "tab-bar",
    });
  }, []);
  const handleCloseTab = useCallback((tabId: string) => {
    void executeCommand({
      args: { tabId },
      id: "tab.close",
      source: "tab-bar",
    });
  }, []);
  const handleResetTerminalTabName = useCallback(async (tabId: string) => {
    await executeCommand({
      args: { tabId },
      id: "tab.resetTerminalName",
      source: "context-menu",
    });
  }, []);
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
  const setTabBarActionsForTab = useCallback(
    (tabId: string, actions: TabBarAction[] | null) => {
      setTabBarActionsByTabId((current) => {
        if (actions === null) {
          if (!(tabId in current)) {
            return current;
          }

          const next = { ...current };
          delete next[tabId];
          return next;
        }

        if (current[tabId] === actions) {
          return current;
        }

        return {
          ...current,
          [tabId]: actions,
        };
      });
    },
    [],
  );

  function clearDragState(): void {
    setDraggingTabId(null);
    setDragOverId(null);
    setDraggingTabWidth(null);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDraggingTabId(String(event.active.id));
    setDraggingTabWidth(event.active.rect.current.initial?.width ?? null);
  }

  function handleDragOver(event: DragOverEvent): void {
    setDragOverId(event.over ? String(event.over.id) : null);
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
    (paneId: string) => {
      const activePaneTabId = activePaneTabIds[paneId] ?? null;
      const activePaneTab =
        paneTabsById[paneId]?.find((tab) => tab.id === activePaneTabId) ?? null;
      const activeTabActions =
        focusedPaneId === paneId
          ? ((activePaneTabId
              ? tabBarActionsByTabId[activePaneTabId]
              : undefined) ?? fallbackTabBarActions(activePaneTab))
          : [];

      return (
        <PaneLeaf
          key={paneId}
          worktree={worktree}
          paneId={paneId}
          paneTabs={paneTabsById[paneId] ?? []}
          activePaneTabId={activePaneTabId}
          activeTabActions={activeTabActions}
          focused={focusedPaneId === paneId}
          dragging={draggingTabId !== null}
          draggingTabId={draggingTabId}
          dragOverId={dragOverId}
          dirtyTabIds={dirtyTabIds}
          lockedTabIds={lockedTabIds}
          onActivateTab={handleActivateTab}
          onPinTab={handlePinTab}
          onCloseTab={handleCloseTab}
          onAddTerminal={() => {
            void executeCommand({
              args: { paneId, worktreeId: worktree.id },
              id: "tab.newTerminal",
              source: "button",
            });
          }}
          onAddBrowser={async () => {
            await executeCommand({
              args: { paneId, worktreeId: worktree.id },
              id: "tab.newBrowser",
              source: "button",
            });
          }}
          onAddChat={async () => {
            await openAgentChat({ worktreeId: worktree.id, paneId });
          }}
          onSplitRight={() => {
            void executeCommand({
              args: {
                paneId,
                projectId: worktree.project_id,
                worktreeId: worktree.id,
              },
              id: "pane.splitRight",
              source: "button",
            });
          }}
          onSplitDown={() => {
            void executeCommand({
              args: {
                paneId,
                projectId: worktree.project_id,
                worktreeId: worktree.id,
              },
              id: "pane.splitDown",
              source: "button",
            });
          }}
          onResetTerminalTabName={handleResetTerminalTabName}
          onFocusPane={() => focusPane(worktree.id, paneId)}
          registerViewport={registerViewport}
          emptyState={emptyState}
        />
      );
    },
    [
      activePaneTabIds,
      dirtyTabIds,
      dragOverId,
      draggingTabId,
      emptyState,
      focusPane,
      focusedPaneId,
      handleActivateTab,
      handleCloseTab,
      handlePinTab,
      handleResetTerminalTabName,
      lockedTabIds,
      openAgentChat,
      paneTabsById,
      registerViewport,
      tabBarActionsByTabId,
      worktree,
    ],
  );

  const sceneRectsByTabId = useMemo(() => {
    const nextKnownRects = { ...lastVisibleSceneRectsRef.current };
    const rectsByTabId: Record<string, ViewportRect | null> = {};

    for (const tab of sceneTabs) {
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
  }, [active, activePaneTabIds, paneViewportRects, sceneTabs]);

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
          onDragOver={handleDragOver}
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
              {sceneTabs.map((tab) => {
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
                    data-tab-scene={tab.id}
                    className={cn(
                      "absolute overflow-hidden bg-background",
                      visible ? "pointer-events-auto" : "pointer-events-none",
                    )}
                    onMouseDown={() => focusPane(worktree.id, tab.pane_id)}
                    style={
                      visible && rect
                        ? {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height,
                          }
                        : PARKED_SCENE_STYLE
                    }
                  >
                    {tab.type === "terminal" ? (
                      <TerminalTab
                        tabId={tab.id}
                        visible={visible}
                        focused={focusedPaneId === tab.pane_id}
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
                        setTabBarActionsForTab={setTabBarActionsForTab}
                      />
                    ) : tab.type === "browser" ? (
                      <BrowserTab tab={tab} visible={visible} />
                    ) : tab.type === "agent_chat" ? (
                      <AgentChatTabView tab={tab} visible={visible} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <DragOverlay>
            {draggingTabId
              ? (() => {
                  const draggedTab =
                    worktreeTabs.find((tab) => tab.id === draggingTabId) ??
                    null;
                  return draggedTab ? (
                    <TabDragOverlay
                      worktreeId={worktree.id}
                      tab={draggedTab}
                      width={draggingTabWidth}
                      isActive={
                        activePaneTabIds[draggedTab.pane_id] === draggedTab.id
                      }
                      paneFocused={focusedPaneId === draggedTab.pane_id}
                    />
                  ) : null;
                })()
              : null}
          </DragOverlay>
        </DndContext>
      </div>

      <WorktreeRightSidebar worktree={worktree} active={active} />
    </div>
  );
}
