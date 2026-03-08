import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  forwardRef,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChevronsLeft, ChevronsRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "$lib/utils";
import type { Tab } from "$lib/types";

const SCROLL_AMOUNT = 200;

type Props = {
  worktreeId: string;
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
};

type TabChipProps = {
  tabId: string;
  label: string;
  isActive: boolean;
  dragging?: boolean;
  isOverlay?: boolean;
  width?: number | null;
  onActivateTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
} & Omit<ComponentPropsWithoutRef<"div">, "onClick" | "children">;

export default function TabBar({
  worktreeId,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onAdd,
  onReorder,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const prevTabCountRef = useRef(tabs.length);
  const sortableItems = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const activeDragTab = useMemo(
    () => tabs.find((tab) => tab.id === activeDragId) ?? null,
    [activeDragId, tabs],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

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

  function clearDragState(): void {
    setDragging(false);
    setActiveDragId(null);
    setActiveDragWidth(null);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDragging(true);
    setActiveDragId(String(event.active.id));
    setActiveDragWidth(event.active.rect.current.initial?.width ?? null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    clearDragState();

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
    const newIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(tabs, oldIndex, newIndex);
    void onReorder(next.map((tab) => tab.id));
  }

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

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={clearDragState}
        >
          <SortableContext
            items={sortableItems}
            strategy={horizontalListSortingStrategy}
          >
            <div
              ref={tabListRef}
              role="tablist"
              className="flex items-center gap-1 overflow-x-auto overflow-y-hidden"
              data-tab-list="true"
              data-tab-dragging={dragging || undefined}
              onScroll={updateScrollState}
            >
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tabId={tab.id}
                  label={tab.label}
                  isActive={tab.id === activeTabId}
                  dragging={dragging}
                  onActivateTab={onActivate}
                  onCloseTab={onClose}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeDragTab ? (
              <SortableTabView
                tabId={activeDragTab.id}
                label={activeDragTab.label}
                isActive={activeDragTab.id === activeTabId}
                isOverlay
                width={activeDragWidth}
              />
            ) : null}
          </DragOverlay>
        </DndContext>

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

export const SortableTab = memo(function SortableTab({
  tabId,
  label,
  isActive,
  dragging,
  onActivateTab,
  onCloseTab,
}: {
  tabId: string;
  label: string;
  isActive: boolean;
  dragging: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tabId });

  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? "none" : undefined,
  };

  return (
    <SortableTabView
      ref={setNodeRef}
      style={style}
      tabId={tabId}
      label={label}
      isActive={isActive}
      dragging={dragging}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
      {...attributes}
      {...listeners}
    />
  );
});

export const SortableTabView = memo(
  forwardRef<HTMLDivElement, TabChipProps>(function SortableTabView(
    {
      tabId,
      label,
      isActive,
      dragging = false,
      isOverlay = false,
      width,
      style,
      onActivateTab,
      onCloseTab,
      className,
      onKeyDown,
      role: _role,
      tabIndex: providedTabIndex,
      ...divProps
    },
    ref,
  ) {
    const mergedStyle =
      width == null
        ? style
        : ({ ...(style ?? {}), width } satisfies CSSProperties);

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
      onKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivateTab?.(tabId);
      }
    }

    function handleClick(event: MouseEvent<HTMLDivElement>): void {
      if (event.defaultPrevented) {
        return;
      }

      onActivateTab?.(tabId);
    }

    return (
      <div
        ref={ref}
        style={mergedStyle}
        className={cn(
          "inline-flex cursor-default select-none items-center gap-1.5 whitespace-nowrap pl-3 pr-2.5 py-2 text-sm transition-colors",
          isActive
            ? "bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]"
            : dragging
              ? "text-tab-inactive-foreground"
              : "text-tab-inactive-foreground hover:text-foreground",
          isOverlay && "pointer-events-none opacity-50",
          className,
        )}
        data-tab-drag-item="true"
        data-tab-overlay={isOverlay || undefined}
        {...divProps}
        role="tab"
        tabIndex={isOverlay ? -1 : (providedTabIndex ?? 0)}
        aria-selected={isActive}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span>{label}</span>
        {isOverlay || !onCloseTab ? null : (
          <button
            type="button"
            aria-label={`Close ${label}`}
            className="rounded-sm opacity-60 hover:opacity-100"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCloseTab(tabId);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }),
);

SortableTabView.displayName = "SortableTabView";
