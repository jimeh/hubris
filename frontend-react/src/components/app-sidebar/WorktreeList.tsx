import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import type { Worktree } from "$lib/types";
import WorktreeDragOverlay from "./WorktreeDragOverlay";
import WorktreeRow from "./WorktreeRow";

type WorktreeListProps = {
  localWorktree: Worktree | null;
  worktrees: Worktree[];
  projectError: string | null;
  selectedWorktreeId: string | null;
  onSelectWorktree: (id: string) => void;
  onRemoveWorktree: (worktree: Worktree) => void;
  onReorder: (orderedIds: string[]) => void;
};

export default function WorktreeList({
  localWorktree,
  worktrees,
  projectError: currentProjectError,
  selectedWorktreeId,
  onSelectWorktree,
  onRemoveWorktree,
  onReorder,
}: WorktreeListProps) {
  const [activeWorktreeDragId, setActiveWorktreeDragId] = useState<
    string | null
  >(null);
  const [activeWorktreeDragWidth, setActiveWorktreeDragWidth] = useState<
    number | null
  >(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );
  const activeWorktree =
    activeWorktreeDragId === null
      ? null
      : (worktrees.find((worktree) => worktree.id === activeWorktreeDragId) ??
        null);

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = worktrees.findIndex(
      (worktree) => worktree.id === active.id,
    );
    const newIndex = worktrees.findIndex((worktree) => worktree.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(worktrees, oldIndex, newIndex);
    onReorder(next.map((worktree) => worktree.id));
  }

  return (
    <div className="mt-1 space-y-1" role="presentation">
      {localWorktree ? (
        <button
          className={[
            "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
            selectedWorktreeId === localWorktree.id
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "text-sidebar-foreground/80",
          ].join(" ")}
          onClick={() => onSelectWorktree(localWorktree.id)}
          type="button"
        >
          <span className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">local</span>
        </button>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => {
          setActiveWorktreeDragId(String(event.active.id));
          setActiveWorktreeDragWidth(
            event.active.rect.current.initial?.width ?? null,
          );
        }}
        onDragEnd={(event) => {
          handleDragEnd(event);
          setActiveWorktreeDragId(null);
          setActiveWorktreeDragWidth(null);
        }}
        onDragCancel={() => {
          setActiveWorktreeDragId(null);
          setActiveWorktreeDragWidth(null);
        }}
      >
        <SortableContext
          items={worktrees.map((worktree) => worktree.id)}
          strategy={rectSortingStrategy}
        >
          <div className="space-y-1">
            {worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.id}
                worktree={worktree}
                isSelected={selectedWorktreeId === worktree.id}
                isSorting={activeWorktreeDragId !== null}
                onSelect={() => onSelectWorktree(worktree.id)}
                onRemove={() => onRemoveWorktree(worktree)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeWorktree ? (
            <WorktreeDragOverlay
              worktree={activeWorktree}
              isSelected={selectedWorktreeId === activeWorktree.id}
              width={activeWorktreeDragWidth}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {currentProjectError ? (
        <p className="px-2 pb-1 text-xs text-destructive">
          {currentProjectError}
        </p>
      ) : null}
    </div>
  );
}
