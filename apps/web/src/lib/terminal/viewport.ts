import type { ClientControlMessage } from "@/lib/contracts/ws.generated";
import type { TerminalViewport } from "./adapter";

const MIN_TERMINAL_COLS = 8;
const MIN_TERMINAL_ROWS = 2;

function clampViewport(viewport: TerminalViewport): TerminalViewport {
  return {
    cols: Math.max(MIN_TERMINAL_COLS, Math.floor(viewport.cols)),
    rows: Math.max(MIN_TERMINAL_ROWS, Math.floor(viewport.rows)),
  };
}

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
  const localViewport = state.measuredViewport
    ? clampViewport(state.measuredViewport)
    : state.localViewport
      ? clampViewport(state.localViewport)
      : null;
  const viewport = state.measuredViewport
    ? clampViewport(state.measuredViewport)
    : state.localViewport
      ? clampViewport(state.localViewport)
      : state.appliedViewport
        ? clampViewport(state.appliedViewport)
        : null;

  if (!state.visible) {
    const hiddenViewport = viewport ?? {
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
    };
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
