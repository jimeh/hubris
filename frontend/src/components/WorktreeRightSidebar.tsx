import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Files,
  GitBranch,
  PanelRightClose,
  type LucideIcon,
} from "lucide-react";
import WorktreeAllFilesPanel from "@/components/WorktreeAllFilesPanel";
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
import { useIsMobile } from "@/hooks/use-mobile";
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
  open?: boolean;
  onActionsChange?: (actions: ReactNode | null) => void;
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
  return (
    <div className="flex items-start justify-between gap-2 border-b px-3 py-2">
      <div className="min-w-0">
        <div className="-ml-1 flex items-center gap-1">
          {Object.values(RIGHT_SIDEBAR_TABS).map((tab) => (
            <Button
              key={tab.id}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 rounded-md px-3 text-sidebar-foreground/75",
                activeTab === tab.id &&
                  "bg-sidebar-accent/70 text-sidebar-accent-foreground hover:bg-sidebar-accent/70",
              )}
              aria-pressed={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              <tab.icon className="mr-2 h-4 w-4" />
              {tab.title}
              {tab.id === WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB &&
              badgeCounts[tab.id] !== null &&
              badgeCounts[tab.id] !== undefined ? (
                <span className="ml-2 rounded-full bg-sidebar-accent px-2 py-0.5 text-[11px] leading-none text-sidebar-accent-foreground">
                  {badgeCounts[tab.id]}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {closeAction}
      </div>
    </div>
  );
}

export default function WorktreeRightSidebar({ worktree }: Props) {
  const isMobile = useIsMobile();
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
  const changesBadgeCount = useWorktreeFileManagerStore((state) => {
    const gitStatus = state.worktrees[worktree.id]?.gitStatus;
    if (!gitStatus) {
      return null;
    }

    return gitStatus.staged_files.length + gitStatus.unstaged_files.length;
  });
  const [tabActions, setTabActions] = useState<ReactNode>(null);

  const tab = useMemo(
    () =>
      RIGHT_SIDEBAR_TABS[activeTab] ??
      RIGHT_SIDEBAR_TABS[DEFAULT_WORKTREE_RIGHT_SIDEBAR_TAB],
    [activeTab],
  );
  const TabContent = tab.Content;

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
              open={mobileOpen}
              onActionsChange={setTabActions}
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
            open={desktopOpen}
            onActionsChange={setTabActions}
          />
        </div>
      </div>
    </div>
  );
}
