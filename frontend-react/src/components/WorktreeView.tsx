import { useEffect, useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTabStore } from "$lib/stores/tabs";
import type { Tab, Worktree } from "$lib/types";
import TerminalTab from "@/components/TerminalTab";

type Props = {
  worktree: Worktree;
};

export default function WorktreeView({ worktree }: Props) {
  const allTabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const switchToWorktree = useTabStore((state) => state.switchToWorktree);
  const addTerminal = useTabStore((state) => state.addTerminal);
  const reorder = useTabStore((state) => state.reorder);
  const activate = useTabStore((state) => state.activate);
  const close = useTabStore((state) => state.close);
  const removeLocal = useTabStore((state) => state.removeLocal);

  const worktreeTabs = useMemo(
    () => allTabs.filter((tab) => tab.worktree_id === worktree.id),
    [allTabs, worktree.id],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  useEffect(() => {
    switchToWorktree(worktree.id);
  }, [switchToWorktree, worktree.id]);

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = worktreeTabs.findIndex((tab) => tab.id === active.id);
    const newIndex = worktreeTabs.findIndex((tab) => tab.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(worktreeTabs, oldIndex, newIndex);
    void reorder(
      worktree.id,
      next.map((tab) => tab.id),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-tab-border bg-tab-bar px-1 py-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={worktreeTabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center gap-1 overflow-x-auto">
              {worktreeTabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  onActivate={() => activate(tab.id)}
                  onClose={() => void close(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => void addTerminal(worktree.id)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {worktreeTabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeTabId ? "absolute inset-0" : "hidden"}
          >
            {tab.type === "terminal" ? (
              <TerminalTab
                tabId={tab.id}
                visible={tab.id === activeTabId}
                onClosed={() => removeLocal(tab.id)}
              />
            ) : null}
          </div>
        ))}

        {worktreeTabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Click + to open a terminal</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type SortableTabProps = {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
};

function SortableTab({ tab, isActive, onActivate, onClose }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "inline-flex cursor-default select-none items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-tab-active text-tab-active-foreground"
          : "text-tab-inactive-foreground hover:text-foreground",
      ].join(" ")}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      aria-selected={isActive}
      {...attributes}
      {...listeners}
    >
      {tab.label}
      <button
        className="ml-1 rounded-sm opacity-60 hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
