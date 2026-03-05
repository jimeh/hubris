<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { getSidebarWidthStore } from '$lib/stores/sidebarWidth.svelte';

  type ResizeState = {
    pointerId: number;
    startX: number;
    startWidth: number;
  };

  const KEYBOARD_RESIZE_STEP = 16;

  const sidebar = useSidebar();
  const sidebarWidthStore = getSidebarWidthStore();

  let resizeState = $state<ResizeState | null>(null);
  let pendingClientX = $state<number | null>(null);
  let resizeRafId: number | null = null;

  function clearQueuedResize(): void {
    if (resizeRafId != null) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = null;
    }
    pendingClientX = null;
  }

  function applyResize(clientX: number): void {
    if (!resizeState) {
      return;
    }

    const delta = clientX - resizeState.startX;
    sidebarWidthStore.setWidth(resizeState.startWidth + delta);
  }

  function flushQueuedResize(): void {
    resizeRafId = null;
    if (pendingClientX == null) {
      return;
    }
    applyResize(pendingClientX);
    pendingClientX = null;
  }

  function queueResize(clientX: number): void {
    pendingClientX = clientX;
    if (resizeRafId != null) {
      return;
    }
    resizeRafId = requestAnimationFrame(flushQueuedResize);
  }

  function handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || sidebar.isMobile || sidebar.state !== 'expanded') {
      return;
    }

    resizeState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: sidebarWidthStore.width,
    };

    sidebarWidthStore.setResizing(true);

    const handle = e.currentTarget as HTMLElement | null;
    handle?.setPointerCapture(e.pointerId);
    clearQueuedResize();
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!resizeState || e.pointerId !== resizeState.pointerId) {
      return;
    }

    queueResize(e.clientX);
  }

  function handlePointerEnd(e: PointerEvent): void {
    if (!resizeState || e.pointerId !== resizeState.pointerId) {
      return;
    }

    const handle = e.currentTarget as HTMLElement | null;
    if (handle?.hasPointerCapture(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    clearQueuedResize();
    applyResize(e.clientX);
    resizeState = null;
    sidebarWidthStore.setResizing(false);
    sidebarWidthStore.flushPendingPersist();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (sidebar.isMobile || sidebar.state !== 'expanded') {
      return;
    }

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
      return;
    }

    e.preventDefault();
    const delta =
      e.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    sidebarWidthStore.setWidth(sidebarWidthStore.width + delta);
  }

  onDestroy(() => {
    clearQueuedResize();
    sidebarWidthStore.setResizing(false);
    sidebarWidthStore.flushPendingPersist();
  });
</script>

<button
  type="button"
  aria-label="Resize sidebar"
  class="fixed inset-y-0 left-[calc(var(--sidebar-width)-4px)] z-30 hidden w-2 cursor-e-resize touch-none bg-transparent p-0 md:block
         after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 hover:after:bg-sidebar-border
         focus-visible:after:bg-sidebar-border"
  class:hidden={sidebar.isMobile || sidebar.state !== 'expanded'}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerEnd}
  onpointercancel={handlePointerEnd}
  onlostpointercapture={handlePointerEnd}
  onkeydown={handleKeydown}
></button>
