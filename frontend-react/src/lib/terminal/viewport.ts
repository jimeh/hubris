import type { ClientControlMessage } from "$lib/contracts/ws.generated";
import type { TerminalViewport } from "./adapter";

export interface TerminalViewportState {
  visible: boolean;
  measuredViewport: TerminalViewport | null;
  localViewport: TerminalViewport | null;
  appliedViewport: TerminalViewport | null;
}

export interface TerminalViewportUpdate {
  localViewport: TerminalViewport | null;
  message: ClientControlMessage | null;
}

export function buildTerminalViewportMessage(
  state: TerminalViewportState,
): TerminalViewportUpdate {
  const localViewport = state.measuredViewport ?? state.localViewport;
  const viewport =
    state.measuredViewport ?? state.localViewport ?? state.appliedViewport;

  if (!state.visible) {
    const hiddenViewport = viewport ?? { cols: 2, rows: 1 };
    return {
      localViewport,
      message: {
        type: "resize",
        cols: hiddenViewport.cols,
        rows: hiddenViewport.rows,
        visible: false,
      },
    };
  }

  if (!viewport) {
    return {
      localViewport,
      message: null,
    };
  }

  return {
    localViewport,
    message: {
      type: "resize",
      cols: viewport.cols,
      rows: viewport.rows,
      visible: true,
    },
  };
}

export function shouldApplyTerminalViewport(
  current: TerminalViewport | null,
  next: TerminalViewport,
): boolean {
  return current?.cols !== next.cols || current?.rows !== next.rows;
}
