import React, { useEffect, useState, useCallback } from "react";
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
import { TerminalTab } from "./TerminalTab";
import { useTabStore } from "@/lib/stores/tabs";
import { Plus, X } from "lucide-react";
import type { Tab, Worktree } from "@/lib/types";

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
      className={`inline-flex cursor-default items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors select-none ${
        isActive
          ? "bg-tab-active text-tab-active-foreground"
          : "text-tab-inactive-foreground hover:text-foreground"
      }`}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
    >
      {tab.label}
      <button
        className="ml-1 rounded-sm opacity-60 hover:opacity-100"
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

interface WorktreeViewProps {
  worktree: Worktree;
}

export function WorktreeView({ worktree }: WorktreeViewProps) {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const switchToWorktree = useTabStore((s) => s.switchToWorktree);
  const activate = useTabStore((s) => s.activate);
  const close = useTabStore((s) => s.close);
  const removeLocal = useTabStore((s) => s.removeLocal);
  const addTerminal = useTabStore((s) => s.addTerminal);
  const reorder = useTabStore((s) => s.reorder);

  const [isTabDragging, setIsTabDragging] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);

  const worktreeTabs = tabs.filter((t) => t.worktree_id === worktree.id);
  const draggedTab = draggedTabId
    ? worktreeTabs.find((t) => t.id === draggedTabId) ?? null
    : null;

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [worktree.id, switchToWorktree]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsTabDragging(true);
    setDraggedTabId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setIsTabDragging(false);
      setDraggedTabId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = worktreeTabs.findIndex((t) => t.id === active.id);
      const newIndex = worktreeTabs.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...worktreeTabs];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      reorder(
        worktree.id,
        reordered.map((t) => t.id),
      );
    },
    [worktreeTabs, worktree.id, reorder],
  );

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center border-b border-tab-border bg-tab-bar px-1 py-1"
        data-tab-dragging={isTabDragging || undefined}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setIsTabDragging(false);
            setDraggedTabId(null);
          }}
        >
          <SortableContext
            items={worktreeTabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center gap-1 overflow-x-auto">
              {worktreeTabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  onActivate={() => activate(tab.id)}
                  onClose={() => close(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay>
            {draggedTab && (
              <div
                className={`inline-flex cursor-grabbing items-center gap-1.5 rounded-md px-3 py-1.5 text-sm select-none ${
                  draggedTab.id === activeTabId
                    ? "bg-tab-active text-tab-active-foreground"
                    : "text-tab-inactive-foreground"
                }`}
              >
                {draggedTab.label}
                <span className="ml-1 rounded-sm opacity-60">
                  <X className="h-3 w-3" />
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => addTerminal(worktree.id)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {worktreeTabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${
              tab.id !== activeTabId ? "hidden" : ""
            }`}
          >
            {tab.type === "terminal" && (
              <TerminalTab
                tabId={tab.id}
                visible={tab.id === activeTabId}
                onClosed={() => removeLocal(tab.id)}
              />
            )}
          </div>
        ))}
        {worktreeTabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Click + to open a terminal</p>
          </div>
        )}
      </div>
    </div>
  );
}
