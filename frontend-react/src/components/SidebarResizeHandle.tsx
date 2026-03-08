import { useCallback, useEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useSidebarWidthStore } from "$lib/stores/sidebarWidth";

const KEYBOARD_RESIZE_STEP = 16;

type ResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

export default function SidebarResizeHandle() {
  const sidebar = useSidebar();
  const width = useSidebarWidthStore((state) => state.width);
  const isResizing = useSidebarWidthStore((state) => state.isResizing);
  const setWidth = useSidebarWidthStore((state) => state.setWidth);
  const setResizing = useSidebarWidthStore((state) => state.setResizing);
  const flushPendingPersist = useSidebarWidthStore(
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
    setWidth(resizeState.startWidth + clientX - resizeState.startX);
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
      aria-label="Resize sidebar"
      className={[
        "fixed inset-y-0 left-[calc(var(--sidebar-width)-4px)] z-30 hidden",
        "w-2 cursor-e-resize touch-none bg-transparent p-0",
        "transition-[left,opacity] duration-200 ease-linear md:block",
        "peer-data-[state=collapsed]:-left-10",
        "peer-data-[state=collapsed]:pointer-events-none",
        "peer-data-[state=collapsed]:opacity-0",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px]",
        "after:-translate-x-1/2 hover:after:bg-sidebar-border",
        "focus-visible:after:bg-sidebar-border",
        isResizing ? "!transition-none" : "",
      ].join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0 || sidebar.isMobile) {
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
        if (sidebar.isMobile) {
          return;
        }

        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }

        event.preventDefault();
        setWidth(
          width +
            (event.key === "ArrowRight"
              ? KEYBOARD_RESIZE_STEP
              : -KEYBOARD_RESIZE_STEP),
        );
      }}
    />
  );
}
