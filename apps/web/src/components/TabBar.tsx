import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  ChevronsLeft,
  ChevronsRight,
  Columns2,
  Globe,
  MessageSquare,
  Rows2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Tab } from "@/lib/types";
import SortableTabStrip from "./tab-bar/SortableTabStrip";

export { default as SortableTabView } from "./tab-bar/SortableTabView";

const SCROLL_AMOUNT = 200;

/**
 * Action contributed by the active tab for the pane header.
 */
export type TabBarAction = {
  id: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
};

type Props = {
  worktreeId: string;
  paneId?: string;
  dropTargetId?: string;
  tabs: Tab[];
  activeTabActions?: TabBarAction[];
  paneFocused?: boolean;
  dirtyTabIds?: string[];
  lockedTabIds?: string[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAddTerminal: () => void;
  onAddBrowser: () => Promise<void>;
  onAddChat?: () => Promise<void>;
  onReorder?: (orderedIds: string[]) => Promise<void>;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onResetTerminalTabName?: (tabId: string) => Promise<void>;
  dragging?: boolean;
  draggingTabId?: string | null;
  dragOverId?: string | null;
};

export default function TabBar({
  worktreeId,
  paneId = "pane-1",
  dropTargetId,
  tabs,
  activeTabActions = [],
  paneFocused = true,
  dirtyTabIds = [],
  lockedTabIds = [],
  activeTabId,
  onActivate,
  onPin,
  onClose,
  onAddTerminal,
  onAddBrowser,
  onAddChat = async () => {},
  onReorder = async () => {},
  onSplitRight,
  onSplitDown,
  onResetTerminalTabName = async () => {},
  dragging = false,
  draggingTabId = null,
  dragOverId = null,
}: Props) {
  const { setNodeRef } = useDroppable({
    id: dropTargetId ?? `pane-tab-bar:${paneId}`,
    disabled: !dragging,
  });
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const prevTabCountRef = useRef(tabs.length);

  function updateScrollState(): void {
    const node = tabListRef.current;
    if (!node) {
      return;
    }

    const { scrollLeft, scrollWidth, clientWidth } = node;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }

  useEffect(() => {
    const node = tabListRef.current;
    if (!node) {
      return;
    }

    const observer = new ResizeObserver(() => updateScrollState());
    observer.observe(node);
    updateScrollState();

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => updateScrollState());
    return () => cancelAnimationFrame(frame);
  }, [tabs.length]);

  useEffect(() => {
    const tabCount = tabs.length;
    let frameId: number | null = null;
    if (tabCount > prevTabCountRef.current && tabListRef.current) {
      frameId = requestAnimationFrame(() => {
        tabListRef.current?.scrollTo({
          left: tabListRef.current.scrollWidth,
          behavior: "smooth",
        });
      });
    }

    prevTabCountRef.current = tabCount;
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [tabs.length]);

  function scrollTabs(direction: "left" | "right"): void {
    if (!tabListRef.current) {
      return;
    }

    tabListRef.current.scrollBy({
      left: direction === "left" ? -SCROLL_AMOUNT : SCROLL_AMOUNT,
      behavior: "smooth",
    });
  }

  return (
    <div
      ref={setNodeRef}
      className="flex min-h-9 items-stretch border-b border-tab-border bg-tab-bar px-1"
      data-worktree-id={worktreeId}
      data-pane-id={paneId}
    >
      <div className="relative min-w-0 flex-1 self-stretch">
        {canScrollLeft ? (
          <button
            type="button"
            aria-label="Scroll tabs left"
            className="absolute top-0 bottom-0 left-0 z-10 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            style={{
              background:
                "linear-gradient(to right, var(--tab-bar) 40%, transparent)",
            }}
            onClick={() => scrollTabs("left")}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <SortableTabStrip
          worktreeId={worktreeId}
          paneId={paneId}
          tabBarDropTargetId={dropTargetId ?? `pane-tab-bar:${paneId}`}
          tabs={tabs}
          dirtyTabIds={dirtyTabIds}
          lockedTabIds={lockedTabIds}
          activeTabId={activeTabId}
          paneFocused={paneFocused}
          tabListRef={tabListRef}
          onScroll={updateScrollState}
          onActivate={onActivate}
          onPin={onPin}
          onClose={onClose}
          onReorder={onReorder}
          onResetTerminalTabName={onResetTerminalTabName}
          dragging={dragging}
          draggingTabId={draggingTabId}
          dragOverId={dragOverId}
        />

        {canScrollRight ? (
          <button
            type="button"
            aria-label="Scroll tabs right"
            className="absolute top-0 right-0 bottom-0 z-10 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            style={{
              background:
                "linear-gradient(to left, var(--tab-bar) 40%, transparent)",
            }}
            onClick={() => scrollTabs("right")}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div
        className="ml-1 flex shrink-0 items-center gap-0.5"
        data-pane-tab-bar-actions
        data-testid={`tab-bar-${paneId}-actions`}
      >
        {activeTabActions.map((action) => {
          const Icon = action.icon;

          return (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={action.label}
              title={action.label}
              className="h-6 w-6"
              disabled={action.disabled}
              onClick={() => {
                void action.onClick();
              }}
            >
              <Icon className="h-2.5 w-2.5" />
            </Button>
          );
        })}
        {activeTabActions.length > 0 ? (
          <div
            className="mx-1 h-3.5 w-px bg-border/80"
            aria-hidden="true"
            data-testid={`tab-bar-${paneId}-divider`}
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Split Vertically"
          title="Split Vertically"
          data-pane-id={paneId}
          className="h-6 w-6"
          onClick={onSplitRight}
        >
          <Columns2 className="h-2.5 w-2.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Split Horizontally"
          title="Split Horizontally"
          data-pane-id={paneId}
          className="h-6 w-6"
          onClick={onSplitDown}
        >
          <Rows2 className="h-2.5 w-2.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New Browser"
          title="New Browser"
          className="h-6 w-6"
          onClick={() => {
            void onAddBrowser();
          }}
        >
          <Globe className="h-2.5 w-2.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New Chat"
          title="New Chat"
          className="h-6 w-6"
          onClick={() => {
            void onAddChat();
          }}
        >
          <MessageSquare className="h-2.5 w-2.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New Terminal"
          title="New Terminal"
          className="h-6 w-6"
          onClick={onAddTerminal}
        >
          <SquareTerminal className="h-2.5 w-2.5" />
        </Button>
      </div>
    </div>
  );
}
