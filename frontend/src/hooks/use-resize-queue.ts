import { useCallback, useEffect, useRef } from "react";

type Options = {
  applyResize: (clientX: number) => void;
  onCleanup: () => void;
};

type UseResizeQueueResult = {
  queueResize: (clientX: number) => void;
  clearQueuedResize: () => void;
};

export function useResizeQueue({
  applyResize,
  onCleanup,
}: Options): UseResizeQueueResult {
  const pendingClientXRef = useRef<number | null>(null);
  const resizeRafIdRef = useRef<number | null>(null);

  const flushQueuedResize = useCallback((): void => {
    resizeRafIdRef.current = null;
    if (pendingClientXRef.current === null) {
      return;
    }
    applyResize(pendingClientXRef.current);
    pendingClientXRef.current = null;
  }, [applyResize]);

  const clearQueuedResize = useCallback((): void => {
    if (resizeRafIdRef.current !== null) {
      cancelAnimationFrame(resizeRafIdRef.current);
    }
    flushQueuedResize();
  }, [flushQueuedResize]);

  const queueResize = useCallback(
    (clientX: number): void => {
      pendingClientXRef.current = clientX;
      if (resizeRafIdRef.current !== null) {
        return;
      }
      resizeRafIdRef.current = requestAnimationFrame(flushQueuedResize);
    },
    [flushQueuedResize],
  );

  useEffect(() => {
    return () => {
      clearQueuedResize();
      onCleanup();
    };
  }, [clearQueuedResize, onCleanup]);

  return {
    queueResize,
    clearQueuedResize,
  };
}
