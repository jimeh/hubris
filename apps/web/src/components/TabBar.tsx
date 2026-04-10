import { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Tab } from "@/lib/types";
import SortableTabStrip from "./tab-bar/SortableTabStrip";
export { default as SortableTabView } from "./tab-bar/SortableTabView";

const SCROLL_AMOUNT = 200;

type Props = {
  worktreeId: string;
  tabs: Tab[];
  dirtyTabIds?: string[];
  lockedTabIds?: string[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
  onRenameTerminalTab?: (tabId: string, label: string) => Promise<void>;
  onResetTerminalTabName?: (tabId: string) => Promise<void>;
};

export default function TabBar({
  worktreeId,
  tabs,
  dirtyTabIds = [],
  lockedTabIds = [],
  activeTabId,
  onActivate,
  onPin,
  onClose,
  onAdd,
  onReorder,
  onRenameTerminalTab = async () => {},
  onResetTerminalTabName = async () => {},
}: Props) {
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
      className="flex min-h-9 items-center border-b border-tab-border bg-tab-bar px-1"
      data-worktree-id={worktreeId}
    >
      <div className="relative min-w-0 flex-1">
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
          tabs={tabs}
          dirtyTabIds={dirtyTabIds}
          lockedTabIds={lockedTabIds}
          activeTabId={activeTabId}
          tabListRef={tabListRef}
          onScroll={updateScrollState}
          onActivate={onActivate}
          onPin={onPin}
          onClose={onClose}
          onReorder={onReorder}
          onRenameTerminalTab={onRenameTerminalTab}
          onResetTerminalTabName={onResetTerminalTabName}
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

      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label="Add tab"
        onClick={onAdd}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
