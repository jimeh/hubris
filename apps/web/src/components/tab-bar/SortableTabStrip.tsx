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
import { useThemeSettings } from "@/lib/stores/theme";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { presentTab } from "@/lib/tabPresentation";
import type { Tab } from "@/lib/types";
import SortableTab from "./SortableTab";
import SortableTabView from "./SortableTabView";

type SortableTabStripProps = {
  worktreeId: string;
  tabs: Tab[];
  activeTabId: string | null;
  tabListRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onActivate: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
  dirtyTabIds?: string[];
  lockedTabIds?: string[];
};

export default function SortableTabStrip({
  worktreeId,
  tabs,
  activeTabId,
  tabListRef,
  onScroll,
  onActivate,
  onPin,
  onClose,
  onReorder,
  dirtyTabIds = [],
  lockedTabIds = [],
}: SortableTabStripProps) {
  const [dragging, setDragging] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
  const dirtyTabIdSet = useMemo(() => new Set(dirtyTabIds), [dirtyTabIds]);
  const lockedTabIdSet = useMemo(() => new Set(lockedTabIds), [lockedTabIds]);
  const theme = useThemeSettings((state) => state.activeTheme);
  const gitStatus = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktreeId]?.gitStatus ?? null,
  );
  const sortableItems = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabPresentations = useMemo(
    () =>
      Object.fromEntries(
        tabs.map((tab) => [tab.id, presentTab(tab, theme, gitStatus)]),
      ),
    [gitStatus, tabs, theme],
  );
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
              label={tabPresentations[tab.id]?.label ?? tab.label}
              labelSuffix={tabPresentations[tab.id]?.labelSuffix}
              statusLabel={tabPresentations[tab.id]?.statusLabel}
              title={tabPresentations[tab.id]?.title ?? tab.label}
              iconKind={tabPresentations[tab.id]?.iconKind}
              iconPath={tabPresentations[tab.id]?.iconPath}
              iconId={tabPresentations[tab.id]?.iconId}
              toneClass={tabPresentations[tab.id]?.toneClass}
              isActive={tab.id === activeTabId}
              preview={tab.preview}
              dirty={dirtyTabIdSet.has(tab.id)}
              notification={tab.type === "terminal" && !!tab.has_notification}
              locked={lockedTabIdSet.has(tab.id)}
              dragging={dragging}
              onActivateTab={onActivate}
              onPinTab={onPin}
              onCloseTab={onClose}
            />
          ))}
        </div>
      </SortableContext>

      <DragOverlay>
        {activeDragTab ? (
          <SortableTabView
            tabId={activeDragTab.id}
            label={
              tabPresentations[activeDragTab.id]?.label ?? activeDragTab.label
            }
            labelSuffix={tabPresentations[activeDragTab.id]?.labelSuffix}
            statusLabel={tabPresentations[activeDragTab.id]?.statusLabel}
            title={
              tabPresentations[activeDragTab.id]?.title ?? activeDragTab.label
            }
            iconKind={tabPresentations[activeDragTab.id]?.iconKind}
            iconPath={tabPresentations[activeDragTab.id]?.iconPath}
            iconId={tabPresentations[activeDragTab.id]?.iconId}
            toneClass={tabPresentations[activeDragTab.id]?.toneClass}
            isActive={activeDragTab.id === activeTabId}
            preview={activeDragTab.preview}
            dirty={dirtyTabIdSet.has(activeDragTab.id)}
            notification={
              activeDragTab.type === "terminal" &&
              !!activeDragTab.has_notification
            }
            locked={lockedTabIdSet.has(activeDragTab.id)}
            isOverlay
            width={activeDragWidth}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
