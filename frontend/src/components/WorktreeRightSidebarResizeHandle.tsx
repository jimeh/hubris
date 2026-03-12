import { useCallback, useEffect, useRef } from "react";
import { useWorktreeRightSidebarWidthStore } from "@/lib/stores/worktreeRightSidebarWidth";

const KEYBOARD_RESIZE_STEP = 16;

type ResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

export default function WorktreeRightSidebarResizeHandle() {
  const width = useWorktreeRightSidebarWidthStore((state) => state.width);
  const setWidth = useWorktreeRightSidebarWidthStore((state) => state.setWidth);
  const setResizing = useWorktreeRightSidebarWidthStore(
    (state) => state.setResizing,
  );
  const flushPendingPersist = useWorktreeRightSidebarWidthStore(
    (state) => state.flushPendingPersist,
  );

  const resizeStateRef = useRef<ResizeState | null>(null);
  const pendingClientXRef = useRef<number | null>(null);
  const resizeRafIdRef = useRef<number | null>(null);

  const clearQueuedResize = useCallback((): void => {
    if (resizeRafIdRef.current !== null) {
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = null;
    }
    pendingClientXRef.current = null;
  }, []);

  function applyResize(clientX: number): void {
    const resizeState = resizeStateRef.current;
    if (!resizeState) {
      return;
    }
    setWidth(resizeState.startWidth + resizeState.startX - clientX);
  }

  function flushQueuedResize(): void {
    resizeRafIdRef.current = null;
    if (pendingClientXRef.current === null) {
      return;
    }
    applyResize(pendingClientXRef.current);
    pendingClientXRef.current = null;
  }

  function queueResize(clientX: number): void {
    pendingClientXRef.current = clientX;
    if (resizeRafIdRef.current !== null) {
      return;
    }
    resizeRafIdRef.current = requestAnimationFrame(flushQueuedResize);
  }

  useEffect(() => {
    return () => {
      clearQueuedResize();
      setResizing(false);
      flushPendingPersist();
    };
  }, [clearQueuedResize, flushPendingPersist, setResizing]);

  return (
    <button
      type="button"
      aria-label="Resize right sidebar"
      data-worktree-right-sidebar-resize-handle
      className={[
        "fixed inset-y-0 right-[calc(var(--worktree-right-sidebar-width)-4px)]",
        "z-30 hidden w-2 cursor-w-resize touch-none bg-transparent p-0 md:block",
        "transition-[right,opacity] duration-200 ease-linear",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px]",
        "after:-translate-x-1/2 hover:after:bg-border",
        "focus-visible:after:bg-border",
      ].join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }

        resizeStateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        setResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        clearQueuedResize();
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (resizeStateRef.current?.pointerId !== event.pointerId) {
          return;
        }
        queueResize(event.clientX);
      }}
      onPointerUp={(event) => {
        if (resizeStateRef.current?.pointerId !== event.pointerId) {
          return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        clearQueuedResize();
        applyResize(event.clientX);
        resizeStateRef.current = null;
        setResizing(false);
        flushPendingPersist();
      }}
      onPointerCancel={(event) => {
        if (resizeStateRef.current?.pointerId !== event.pointerId) {
          return;
        }
        clearQueuedResize();
        resizeStateRef.current = null;
        setResizing(false);
        flushPendingPersist();
      }}
      onLostPointerCapture={() => {
        clearQueuedResize();
        resizeStateRef.current = null;
        setResizing(false);
        flushPendingPersist();
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }

        event.preventDefault();
        setWidth(
          width +
            (event.key === "ArrowLeft"
              ? KEYBOARD_RESIZE_STEP
              : -KEYBOARD_RESIZE_STEP),
        );
      }}
    />
  );
}
