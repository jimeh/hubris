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
} from "@dnd-kit/sortable";
import { useMemo, useState, type RefObject, type UIEventHandler } from "react";
import type { Tab } from "@/lib/types";
import SortableTab from "./SortableTab";
import SortableTabView from "./SortableTabView";

type SortableTabStripProps = {
  tabs: Tab[];
  activeTabId: string | null;
  tabListRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
};

export default function SortableTabStrip({
  tabs,
  activeTabId,
  tabListRef,
  onScroll,
  onActivate,
  onClose,
  onReorder,
}: SortableTabStripProps) {
  const [dragging, setDragging] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
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

  return (
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
          onScroll={onScroll}
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
  );
}
