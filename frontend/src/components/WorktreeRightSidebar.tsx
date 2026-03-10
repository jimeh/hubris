import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DEFAULT_WORKTREE_RIGHT_SIDEBAR_PANEL,
  type WorktreeRightSidebarPanelId,
} from "@/lib/worktreeRightSidebar";
import { useWorktreeRightSidebarStore } from "@/lib/stores/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import WorktreeGitStatusPanel from "@/components/WorktreeGitStatusPanel";
import WorktreeRightSidebarResizeHandle from "@/components/WorktreeRightSidebarResizeHandle";

const DESKTOP_RAIL_WIDTH_PX = 44;

type WorktreeRightSidebarPanelProps = {
  worktree: Worktree;
  onActionsChange?: (actions: ReactNode | null) => void;
};

type WorktreeRightSidebarPanelDefinition = {
  id: WorktreeRightSidebarPanelId;
  title: string;
  description: string;
  icon: LucideIcon;
  Content: ComponentType<WorktreeRightSidebarPanelProps>;
};

const RIGHT_SIDEBAR_PANELS: Record<
  WorktreeRightSidebarPanelId,
  WorktreeRightSidebarPanelDefinition
> = {
  "git-status": {
    id: "git-status",
    title: "Git status",
    description: "Review staged, unstaged, and ahead changes.",
    icon: GitBranch,
    Content: WorktreeGitStatusPanel,
  },
};

type Props = {
  worktree: Worktree;
};

function RightSidebarHeader({
  title,
  worktreeName,
  Icon,
  actions,
  onCollapse,
}: {
  title: string;
  worktreeName: string;
  Icon: LucideIcon;
  actions: ReactNode;
  onCollapse?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {worktreeName}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onCollapse ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCollapse}
            title="Collapse right sidebar"
            aria-label="Collapse right sidebar"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        ) : null}
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
  const activePanel = useWorktreeRightSidebarStore(
    (state) => state.activePanel,
  );
  const setMobileOpen = useWorktreeRightSidebarStore(
    (state) => state.setMobileOpen,
  );
  const toggleDesktop = useWorktreeRightSidebarStore(
    (state) => state.toggleDesktop,
  );
  const [panelActions, setPanelActions] = useState<ReactNode>(null);

  const panel = useMemo(
    () =>
      RIGHT_SIDEBAR_PANELS[activePanel] ??
      RIGHT_SIDEBAR_PANELS[DEFAULT_WORKTREE_RIGHT_SIDEBAR_PANEL],
    [activePanel],
  );
  const PanelContent = panel.Content;
  const PanelIcon = panel.icon;

  if (isMobile) {
    return (
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          className="w-full max-w-none gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{panel.title}</SheetTitle>
            <SheetDescription>{panel.description}</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col">
            <RightSidebarHeader
              title={panel.title}
              worktreeName={worktree.name}
              Icon={PanelIcon}
              actions={panelActions}
            />
            <PanelContent
              key={`${panel.id}:${worktree.id}:mobile`}
              worktree={worktree}
              onActionsChange={setPanelActions}
            />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      data-worktree-right-sidebar-wrapper
      className="relative hidden shrink-0 border-l bg-background transition-[width] duration-200 ease-linear md:flex md:flex-col"
      style={{
        width: desktopOpen
          ? "var(--worktree-right-sidebar-width, 320px)"
          : `${DESKTOP_RAIL_WIDTH_PX}px`,
      }}
    >
      {desktopOpen ? (
        <>
          <WorktreeRightSidebarResizeHandle />
          <div className="flex min-h-0 flex-1 flex-col">
            <RightSidebarHeader
              title={panel.title}
              worktreeName={worktree.name}
              Icon={PanelIcon}
              actions={panelActions}
              onCollapse={toggleDesktop}
            />
            <PanelContent
              key={`${panel.id}:${worktree.id}:desktop`}
              worktree={worktree}
              onActionsChange={setPanelActions}
            />
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center gap-2 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleDesktop}
            title="Expand right sidebar"
            aria-label="Expand right sidebar"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Separator className="w-6" />
          <PanelIcon className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
