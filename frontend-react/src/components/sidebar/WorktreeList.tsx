import { useRef, useState } from "react";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Worktree } from "@/lib/types";
import { WorktreeItem } from "./WorktreeItem";

interface WorktreeListProps {
  projectId: string;
  worktrees: Worktree[];
  localWorktree: Worktree | null;
  selectedWorktreeId: string | null;
  projectError: string | null;
  onSelectWorktree: (id: string) => void;
  onRequestRemoveWorktree: (projectId: string, worktree: Worktree) => void;
  onReorder: (projectId: string, ids: string[]) => void;
}

export function WorktreeList({
  projectId,
  worktrees,
  localWorktree,
  selectedWorktreeId,
  projectError,
  onSelectWorktree,
  onRequestRemoveWorktree,
  onReorder,
}: WorktreeListProps) {
  const nonLocal = worktrees.filter((wt) => !wt.is_local);

  const [isDragging, setIsDragging] = useState(false);
  const dragSnapshotRef = useRef<{
    html: string;
    width: number;
  } | null>(null);
  const [, forceRender] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    setIsDragging(true);

    const el = document.querySelector(
      `[data-worktree-drag-item="true"][data-worktree-id="${event.active.id}"]`,
    );
    if (el instanceof HTMLElement) {
      dragSnapshotRef.current = {
        html: el.innerHTML,
        width: el.getBoundingClientRect().width,
      };
    }
    forceRender((n) => n + 1);
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false);
    dragSnapshotRef.current = null;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = nonLocal.findIndex((wt) => wt.id === active.id);
    const newIndex = nonLocal.findIndex((wt) => wt.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...nonLocal];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    onReorder(
      projectId,
      reordered.map((wt) => wt.id),
    );
  }

  return (
    <div
      className="mt-1 space-y-1"
      role="presentation"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {localWorktree && (
        <WorktreeItem
          worktree={localWorktree}
          isSelected={selectedWorktreeId === localWorktree.id}
          onSelect={() => onSelectWorktree(localWorktree.id)}
        />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setIsDragging(false);
          dragSnapshotRef.current = null;
        }}
      >
        <SortableContext
          items={nonLocal.map((wt) => wt.id)}
          strategy={verticalListSortingStrategy}
        >
          <div
            className="space-y-1"
            data-worktree-dragging={isDragging || undefined}
          >
            {nonLocal.map((worktree) => (
              <WorktreeItem
                key={worktree.id}
                worktree={worktree}
                isSelected={selectedWorktreeId === worktree.id}
                onSelect={() => onSelectWorktree(worktree.id)}
                onRequestRemove={() =>
                  onRequestRemoveWorktree(projectId, worktree)
                }
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {dragSnapshotRef.current && (
            <div
              className="group/worktree-item relative opacity-50"
              style={{
                width: dragSnapshotRef.current.width,
              }}
              dangerouslySetInnerHTML={{
                __html: dragSnapshotRef.current.html,
              }}
            />
          )}
        </DragOverlay>
      </DndContext>

      {projectError && (
        <p className="px-2 pb-1 text-xs text-destructive">{projectError}</p>
      )}
    </div>
  );
}
