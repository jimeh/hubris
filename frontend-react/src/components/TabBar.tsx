import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Plus, X, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useTabStore } from "@/lib/stores/tabs";
import type { Tab } from "@/lib/types";

const SCROLL_AMOUNT = 200;

// ---------------------------------------------------------------------------
// SortableTab (internal)
// ---------------------------------------------------------------------------

interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}

const SortableTab = React.memo(function SortableTab({
  tab,
  isActive,
  onActivate,
  onClose,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-tab-drag-item="true"
      className={`inline-flex cursor-default items-center gap-1.5 whitespace-nowrap pl-3 pr-2.5 py-2 text-sm transition-colors select-none ${
        isActive
          ? "bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]"
          : "text-tab-inactive-foreground hover:text-foreground"
      }`}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
    >
      {tab.label}
      <button
        type="button"
        aria-label="Close tab"
        className="rounded-sm opacity-60 hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

interface TabBarProps {
  worktreeId: string;
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

export function TabBar({
  worktreeId,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onAdd,
}: TabBarProps) {
  const reorder = useTabStore((s) => s.reorder);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const draggedTab = draggedTabId
    ? (tabs.find((t) => t.id === draggedTabId) ?? null)
    : null;

  // Scroll state
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = tabListRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  // ResizeObserver for scroll indicator updates
  useEffect(() => {
    const el = tabListRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => updateScrollState());
    observer.observe(el);
    updateScrollState();
    return () => observer.disconnect();
  }, [updateScrollState]);

  // Re-evaluate scroll indicators when tab count changes
  useEffect(() => {
    requestAnimationFrame(() => updateScrollState());
  }, [tabs.length, updateScrollState]);

  // Auto-scroll to end when tabs are added
  const prevTabCount = useRef(tabs.length);
  useEffect(() => {
    if (tabs.length > prevTabCount.current && tabListRef.current) {
      const el = tabListRef.current;
      requestAnimationFrame(() => {
        el.scrollTo({
          left: el.scrollWidth,
          behavior: "smooth",
        });
      });
    }
    prevTabCount.current = tabs.length;
  }, [tabs.length]);

  function scrollTabs(direction: "left" | "right") {
    const el = tabListRef.current;
    if (!el) return;
    const delta = direction === "left" ? -SCROLL_AMOUNT : SCROLL_AMOUNT;
    el.scrollBy({ left: delta, behavior: "smooth" });
  }

  // DnD
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true);
    setDraggedTabId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setIsDragging(false);
      setDraggedTabId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...tabs];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      reorder(
        worktreeId,
        reordered.map((t) => t.id),
      );
    },
    [tabs, worktreeId, reorder],
  );

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDraggedTabId(null);
  }, []);

  return (
    <div className="flex min-h-9 items-center border-b border-tab-border bg-tab-bar px-1">
      <div className="relative min-w-0 flex-1">
        {canScrollLeft && (
          <button
            type="button"
            aria-label="Scroll tabs left"
            className="absolute top-0 bottom-0 left-0 z-10 flex w-6 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
            style={{
              background:
                "linear-gradient(to right, var(--tab-bar) 40%, transparent)",
            }}
            onClick={() => scrollTabs("left")}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              ref={tabListRef}
              role="tablist"
              className="flex items-center gap-1 overflow-x-auto overflow-y-hidden"
              data-tab-dragging={isDragging || undefined}
              onScroll={updateScrollState}
            >
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  onActivate={() => onActivate(tab.id)}
                  onClose={() => onClose(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay>
            {draggedTab && (
              <div
                className={`inline-flex cursor-default items-center gap-1.5 whitespace-nowrap pl-3 pr-2.5 py-2 text-sm opacity-50 select-none ${
                  draggedTab.id === activeTabId
                    ? "bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]"
                    : "text-tab-inactive-foreground"
                }`}
              >
                {draggedTab.label}
                <span className="rounded-sm opacity-60">
                  <X className="h-3 w-3" />
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {canScrollRight && (
          <button
            type="button"
            aria-label="Scroll tabs right"
            className="absolute top-0 right-0 bottom-0 z-10 flex w-6 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
            style={{
              background:
                "linear-gradient(to left, var(--tab-bar) 40%, transparent)",
            }}
            onClick={() => scrollTabs("right")}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onAdd}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
