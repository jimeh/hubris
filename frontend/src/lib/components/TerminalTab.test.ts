// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildTerminalViewportMessage,
  shouldApplyTerminalViewport,
} from "$lib/terminal/viewport";
import {
  shouldFlushBufferedInputAfterResize,
  shouldKeepBufferedInputQueued,
} from "$lib/terminal/reconnect";

describe("TerminalTab viewport logic", () => {
  it("uses the measured local viewport for visible tabs", () => {
    const result = buildTerminalViewportMessage({
      visible: true,
      measuredViewport: { cols: 120, rows: 40 },
      localViewport: null,
      appliedViewport: { cols: 80, rows: 24 },
    });

    expect(result.localViewport).toEqual({ cols: 120, rows: 40 });
    expect(result.message).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
      visible: true,
    });
  });

  it("marks hidden tabs as non-participating even without a fresh measurement", () => {
    const result = buildTerminalViewportMessage({
      visible: false,
      measuredViewport: null,
      localViewport: { cols: 120, rows: 40 },
      appliedViewport: { cols: 90, rows: 30 },
    });

    expect(result.message).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
      visible: false,
    });
  });

  it("applies only server-driven PTY size changes", () => {
    expect(
      shouldApplyTerminalViewport(
        { cols: 90, rows: 30 },
        { cols: 90, rows: 30 },
      ),
    ).toBe(false);

    expect(
      shouldApplyTerminalViewport(
        { cols: 90, rows: 30 },
        { cols: 80, rows: 24 },
      ),
    ).toBe(true);
  });

  it("flushes buffered input only after a resize frame is sent", () => {
    expect(shouldFlushBufferedInputAfterResize(true, true)).toBe(true);
    expect(shouldFlushBufferedInputAfterResize(false, true)).toBe(false);
    expect(shouldFlushBufferedInputAfterResize(true, false)).toBe(false);
  });

  it("keeps buffered input queued when resize could not be sent yet", () => {
    expect(shouldKeepBufferedInputQueued(false, true)).toBe(true);
    expect(shouldKeepBufferedInputQueued(true, true)).toBe(false);
    expect(shouldKeepBufferedInputQueued(false, false)).toBe(false);
  });
});
