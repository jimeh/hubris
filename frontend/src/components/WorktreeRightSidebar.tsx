import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Files,
  GitBranch,
  PanelRightClose,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import WorktreeAllFilesPanel from "@/components/WorktreeAllFilesPanel";
import WorktreeGitStatusViewToggle from "@/components/WorktreeGitStatusViewToggle";
import WorktreeGitStatusPanel from "@/components/WorktreeGitStatusPanel";
import WorktreeRightSidebarResizeHandle from "@/components/WorktreeRightSidebarResizeHandle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useWorktreeGitStatusViewStore } from "@/lib/stores/worktreeGitStatusView";
import {
  DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB,
  WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
  WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
  type WorktreeRightSidebarTabId,
} from "@/lib/worktreeRightSidebar";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useWorktreeRightSidebarStore } from "@/lib/stores/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

type WorktreeRightSidebarTabProps = {
  worktree: Worktree;
};

type WorktreeRightSidebarTabDefinition = {
  id: WorktreeRightSidebarTabId;
  title: string;
  description: string;
  icon: LucideIcon;
  Content: ComponentType<WorktreeRightSidebarTabProps>;
};

const RIGHT_SIDEBAR_TABS: Record<
  WorktreeRightSidebarTabId,
  WorktreeRightSidebarTabDefinition
> = {
  [WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB]: {
    id: WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
    title: "All Files",
    description: "Browse the worktree with git-aware decorations.",
    icon: Files,
    Content: WorktreeAllFilesPanel,
  },
  [WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB]: {
    id: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
    title: "Changes",
    description: "Review staged, unstaged, and ahead changes.",
    icon: GitBranch,
    Content: WorktreeGitStatusPanel,
  },
};

type Props = {
  worktree: Worktree;
};

const HEADER_SECTION_GAP_PX = 8;
const HEADER_COLLAPSE_BUFFER_PX = 16;

function RightSidebarHeader({
  activeTab,
  onTabChange,
  badgeCounts,
  actions,
  closeAction,
}: {
  activeTab: WorktreeRightSidebarTabId;
  onTabChange: (tabId: WorktreeRightSidebarTabId) => void;
  badgeCounts: Partial<Record<WorktreeRightSidebarTabId, number | null>>;
  actions: ReactNode;
  closeAction?: ReactNode;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const tabsMeasureRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);

  const changesBadgeCount = badgeCounts[WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB];

  const measureCompactTabs = useCallback(() => {
    const availableWidth = headerRef.current?.clientWidth ?? 0;
    const tabsWidth = tabsMeasureRef.current?.scrollWidth ?? 0;
    const actionsWidth = actionsRef.current?.scrollWidth ?? 0;

    if (availableWidth === 0 || tabsWidth === 0) {
      setCompactTabs(false);
      return;
    }

    setCompactTabs(
      tabsWidth +
        actionsWidth +
        HEADER_SECTION_GAP_PX +
        HEADER_COLLAPSE_BUFFER_PX >
        availableWidth,
    );
  }, []);

  useLayoutEffect(() => {
    const frameId = requestAnimationFrame(() => {
      measureCompactTabs();
    });

    const observer = new ResizeObserver(() => {
      measureCompactTabs();
    });

    if (headerRef.current) {
      observer.observe(headerRef.current);
    }
    if (tabsMeasureRef.current) {
      observer.observe(tabsMeasureRef.current);
    }
    if (actionsRef.current) {
      observer.observe(actionsRef.current);
    }

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [activeTab, changesBadgeCount, closeAction, measureCompactTabs]);

  function renderTabButton(
    tab: WorktreeRightSidebarTabDefinition,
    variant: "visible" | "measure",
  ) {
    const Icon = tab.icon;
    const isActive = activeTab === tab.id;
    const isCompact = variant === "visible" && compactTabs;
    const isMeasure = variant === "measure";
    const badgeCount =
      tab.id === WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB ? changesBadgeCount : null;

    return (
      <Button
        key={`${variant}:${tab.id}`}
        type="button"
        variant="ghost"
        size="sm"
        tabIndex={isMeasure ? -1 : undefined}
        className={cn(
          "h-8 rounded-md text-sidebar-foreground/75",
          isCompact ? "relative size-8 px-0" : "px-3",
          isActive &&
            "bg-sidebar-accent/70 text-sidebar-accent-foreground hover:bg-sidebar-accent/70",
        )}
        title={tab.title}
        aria-label={isCompact ? tab.title : undefined}
        aria-hidden={isMeasure}
        aria-pressed={isMeasure ? undefined : isActive}
        onClick={isMeasure ? undefined : () => onTabChange(tab.id)}
      >
        <Icon className={cn("h-4 w-4", isCompact ? "" : "mr-2")} />
        {isCompact ? null : tab.title}
        {badgeCount !== null && badgeCount !== undefined ? (
          <span
            className={cn(
              "rounded-full bg-sidebar-accent text-sidebar-accent-foreground",
              isCompact
                ? "absolute top-0.5 right-0.5 min-w-4 px-1 py-0 text-[10px] leading-none"
                : "ml-2 px-2 py-0.5 text-[11px] leading-none",
            )}
          >
            {badgeCount}
          </span>
        ) : null}
      </Button>
    );
  }

  return (
    <div
      ref={headerRef}
      data-worktree-right-sidebar-header
      data-compact-tabs={compactTabs ? "true" : "false"}
      className="relative flex items-start justify-between gap-2 border-b px-3 py-2"
    >
      <div className="min-w-0">
        <div
          data-worktree-right-sidebar-tabs
          className="-ml-1 flex items-center gap-1"
        >
          {Object.values(RIGHT_SIDEBAR_TABS).map((tab) =>
            renderTabButton(tab, "visible"),
          )}
        </div>
      </div>
      <div
        ref={actionsRef}
        data-worktree-right-sidebar-actions
        className="flex shrink-0 items-center gap-1"
      >
        {actions}
        {closeAction}
      </div>
      <div
        ref={tabsMeasureRef}
        data-worktree-right-sidebar-tabs-measure
        aria-hidden="true"
        className="pointer-events-none absolute top-2 left-3 invisible h-0 overflow-hidden whitespace-nowrap"
      >
        <div className="-ml-1 flex items-center gap-1">
          {Object.values(RIGHT_SIDEBAR_TABS).map((tab) =>
            renderTabButton(tab, "measure"),
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorktreeRightSidebar({ worktree }: Props) {
  const isMobile = useWorktreeRightSidebarStore(
    (state) => state.isMobileViewport,
  );
  const desktopOpen = useWorktreeRightSidebarStore(
    (state) => state.desktopOpen,
  );
  const mobileOpen = useWorktreeRightSidebarStore((state) => state.mobileOpen);
  const activeTab = useWorktreeRightSidebarStore((state) => state.activeTab);
  const setMobileOpen = useWorktreeRightSidebarStore(
    (state) => state.setMobileOpen,
  );
  const setActiveTab = useWorktreeRightSidebarStore(
    (state) => state.setActiveTab,
  );
  const worktreeState = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktree.id],
  );
  const refreshVisiblePaths = useWorktreeFileManagerStore(
    (state) => state.refreshVisiblePaths,
  );
  const loadGitStatus = useWorktreeFileManagerStore(
    (state) => state.loadGitStatus,
  );
  const changesBadgeCount = useMemo(() => {
    const gitStatus = worktreeState?.gitStatus;
    if (!gitStatus) {
      return null;
    }

    return gitStatus.staged_files.length + gitStatus.unstaged_files.length;
  }, [worktreeState?.gitStatus]);
  const viewMode = useWorktreeGitStatusViewStore(
    (state) => state.viewModeByWorktree[worktree.id] ?? "tree",
  );
  const setStoredViewMode = useWorktreeGitStatusViewStore(
    (state) => state.setViewMode,
  );

  const tab = useMemo(
    () =>
      RIGHT_SIDEBAR_TABS[activeTab] ??
      RIGHT_SIDEBAR_TABS[DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB],
    [activeTab],
  );
  const TabContent = tab.Content;
  const allFilesLoading =
    worktreeState?.directories[""]?.status === "loading-initial" ||
    worktreeState?.directories[""]?.status === "loading-refresh" ||
    worktreeState?.gitStatusStatus === "loading";
  const changesLoading = worktreeState?.gitStatusStatus === "loading";

  const handleAllFilesRefresh = useCallback(() => {
    void refreshVisiblePaths(worktree.project_id, worktree.id, {
      force: true,
    });
  }, [refreshVisiblePaths, worktree.id, worktree.project_id]);

  const handleChangesRefresh = useCallback(() => {
    void loadGitStatus(worktree.project_id, worktree.id, {
      force: true,
    });
  }, [loadGitStatus, worktree.id, worktree.project_id]);

  const handleViewModeChange = useCallback(
    (nextViewMode: "list" | "tree") => {
      setStoredViewMode(worktree.id, nextViewMode);
    },
    [setStoredViewMode, worktree.id],
  );

  const tabActions = useMemo(() => {
    if (activeTab === WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB) {
      return (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleAllFilesRefresh}
          title="Refresh files"
          aria-label="Refresh files"
        >
          <RefreshCw
            className={cn("h-4 w-4", allFilesLoading && "animate-spin")}
          />
        </Button>
      );
    }

    return (
      <>
        <WorktreeGitStatusViewToggle
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleChangesRefresh}
          title="Refresh git status"
          aria-label="Refresh git status"
        >
          <RefreshCw
            className={cn("h-4 w-4", changesLoading && "animate-spin")}
          />
        </Button>
      </>
    );
  }, [
    activeTab,
    allFilesLoading,
    changesLoading,
    handleAllFilesRefresh,
    handleChangesRefresh,
    handleViewModeChange,
    viewMode,
  ]);

  if (isMobile) {
    return (
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full max-w-none gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{tab.title}</SheetTitle>
            <SheetDescription>{tab.description}</SheetDescription>
          </SheetHeader>
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <RightSidebarHeader
              activeTab={activeTab}
              onTabChange={setActiveTab}
              badgeCounts={{
                [WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB]: changesBadgeCount,
              }}
              actions={tabActions}
              closeAction={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-lg border border-border/70 bg-background/70 shadow-xs"
                  aria-label="Hide right sidebar"
                  onClick={() => setMobileOpen(false)}
                >
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              }
            />
            <TabContent
              key={`${tab.id}:${worktree.id}:mobile`}
              worktree={worktree}
            />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      data-worktree-right-sidebar-wrapper
      data-state={desktopOpen ? "open" : "closed"}
      className="relative hidden h-full shrink-0 overflow-visible md:block"
    >
      <div
        data-worktree-right-sidebar-gap
        className={[
          "h-full bg-transparent transition-[width] duration-200 ease-linear",
          desktopOpen ? "border-l" : "",
        ].join(" ")}
        style={{
          width: desktopOpen
            ? "var(--worktree-right-sidebar-width, 320px)"
            : "0px",
        }}
      />
      {desktopOpen ? <WorktreeRightSidebarResizeHandle /> : null}
      <div
        data-worktree-right-sidebar-panel
        aria-hidden={!desktopOpen}
        inert={!desktopOpen}
        className={[
          "absolute inset-y-0 right-0 z-10 hidden h-full w-(--worktree-right-sidebar-width) bg-background md:flex md:flex-col",
          "transition-transform duration-200 ease-linear",
          desktopOpen
            ? "translate-x-0"
            : "translate-x-full pointer-events-none",
          "border-l",
        ].join(" ")}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RightSidebarHeader
            activeTab={activeTab}
            onTabChange={setActiveTab}
            badgeCounts={{
              [WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB]: changesBadgeCount,
            }}
            actions={tabActions}
          />
          <TabContent
            key={`${tab.id}:${worktree.id}:desktop`}
            worktree={worktree}
          />
        </div>
      </div>
    </div>
  );
}
