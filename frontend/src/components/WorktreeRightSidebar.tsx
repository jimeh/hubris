import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { GitBranch, PanelRightClose, type LucideIcon } from "lucide-react";
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
import WorktreeGitStatusPanel from "@/components/WorktreeGitStatusPanel";
import WorktreeRightSidebarResizeHandle from "@/components/WorktreeRightSidebarResizeHandle";

type WorktreeRightSidebarPanelProps = {
  worktree: Worktree;
  open?: boolean;
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
  closeAction,
}: {
  title: string;
  worktreeName: string;
  Icon: LucideIcon;
  actions: ReactNode;
  closeAction?: ReactNode;
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
  const activePanel = useWorktreeRightSidebarStore(
    (state) => state.activePanel,
  );
  const setMobileOpen = useWorktreeRightSidebarStore(
    (state) => state.setMobileOpen,
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
          showCloseButton={false}
          className="w-full max-w-none gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{panel.title}</SheetTitle>
            <SheetDescription>{panel.description}</SheetDescription>
          </SheetHeader>
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <RightSidebarHeader
              title={panel.title}
              worktreeName={worktree.name}
              Icon={PanelIcon}
              actions={panelActions}
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
            <PanelContent
              key={`${panel.id}:${worktree.id}:mobile`}
              worktree={worktree}
              open={mobileOpen}
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
      data-state={desktopOpen ? "open" : "closed"}
      className="relative hidden shrink-0 overflow-visible md:block"
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
            title={panel.title}
            worktreeName={worktree.name}
            Icon={PanelIcon}
            actions={panelActions}
          />
          <PanelContent
            key={`${panel.id}:${worktree.id}:desktop`}
            worktree={worktree}
            open={desktopOpen}
            onActionsChange={setPanelActions}
          />
        </div>
      </div>
    </div>
  );
}
