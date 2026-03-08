import { useCallback, useEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useSidebarWidthStore } from "@/lib/stores/sidebarWidth";
import { cn } from "@/lib/utils";

const KEYBOARD_RESIZE_STEP = 16;

type ResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

export function SidebarResizeHandle() {
  const { isMobile } = useSidebar();
  const width = useSidebarWidthStore((s) => s.width);
  const isResizing = useSidebarWidthStore((s) => s.isResizing);
  const setWidth = useSidebarWidthStore((s) => s.setWidth);
  const setResizing = useSidebarWidthStore((s) => s.setResizing);
  const flushPendingPersist = useSidebarWidthStore(
    (s) => s.flushPendingPersist,
  );

  const resizeStateRef = useRef<ResizeState | null>(null);
  const pendingClientXRef = useRef<number | null>(null);
  const resizeRafIdRef = useRef<number | null>(null);

  const clearQueuedResize = useCallback(() => {
    if (resizeRafIdRef.current != null) {
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = null;
    }
    pendingClientXRef.current = null;
  }, []);

  const applyResize = useCallback(
    (clientX: number) => {
      const rs = resizeStateRef.current;
      if (!rs) return;
      const delta = clientX - rs.startX;
      setWidth(rs.startWidth + delta);
    },
    [setWidth],
  );

  const flushQueuedResize = useCallback(() => {
    resizeRafIdRef.current = null;
    if (pendingClientXRef.current == null) return;
    applyResize(pendingClientXRef.current);
    pendingClientXRef.current = null;
  }, [applyResize]);

  const queueResize = useCallback(
    (clientX: number) => {
      pendingClientXRef.current = clientX;
      if (resizeRafIdRef.current != null) return;
      resizeRafIdRef.current = requestAnimationFrame(flushQueuedResize);
    },
    [flushQueuedResize],
  );

  useEffect(() => {
    return () => {
      clearQueuedResize();
      setResizing(false);
      flushPendingPersist();
    };
  }, [clearQueuedResize, setResizing, flushPendingPersist]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || isMobile) return;

      resizeStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: width,
      };
      setResizing(true);

      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      clearQueuedResize();
      e.preventDefault();
    },
    [isMobile, width, setResizing, clearQueuedResize],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeStateRef.current;
      if (!rs || e.pointerId !== rs.pointerId) return;
      queueResize(e.clientX);
    },
    [queueResize],
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeStateRef.current;
      if (!rs || e.pointerId !== rs.pointerId) return;

      const handle = e.currentTarget as HTMLElement;
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }
      clearQueuedResize();
      applyResize(e.clientX);
      resizeStateRef.current = null;
      setResizing(false);
      flushPendingPersist();
    },
    [clearQueuedResize, applyResize, setResizing, flushPendingPersist],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isMobile) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
        return;
      }
      e.preventDefault();
      const delta =
        e.key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      setWidth(width + delta);
    },
    [isMobile, width, setWidth],
  );

  return (
    <button
      type="button"
      aria-label="Resize sidebar"
      className={cn(
        "fixed inset-y-0 left-[calc(var(--sidebar-width)-4px)]",
        "z-30 hidden w-2 cursor-e-resize touch-none",
        "bg-transparent p-0 transition-[left,opacity]",
        "duration-200 ease-linear md:block",
        "peer-data-[state=collapsed]:-left-10",
        "peer-data-[state=collapsed]:pointer-events-none",
        "peer-data-[state=collapsed]:opacity-0",
        "after:absolute after:inset-y-0 after:left-1/2",
        "after:w-[2px] after:-translate-x-1/2",
        "hover:after:bg-sidebar-border",
        "focus-visible:after:bg-sidebar-border",
        isResizing && "!transition-none",
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onKeyDown={handleKeyDown}
    />
  );
}
