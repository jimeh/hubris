import { describe, expect, it } from "vitest";

import {
  buildTerminalViewportMessage,
  shouldApplyTerminalViewport,
} from "./viewport";

describe("terminal viewport logic", () => {
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

  it("switches resize participation when tab visibility changes", () => {
    const visibleMessage = buildTerminalViewportMessage({
      visible: true,
      measuredViewport: { cols: 120, rows: 40 },
      localViewport: { cols: 120, rows: 40 },
      appliedViewport: { cols: 80, rows: 24 },
    });
    const hiddenMessage = buildTerminalViewportMessage({
      visible: false,
      measuredViewport: null,
      localViewport: visibleMessage.localViewport,
      appliedViewport: { cols: 80, rows: 24 },
    });

    expect(visibleMessage.message).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
      visible: true,
    });
    expect(hiddenMessage.message).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
      visible: false,
    });
  });

  it("falls back to the applied pty size when hiding before measurement is ready", () => {
    const hiddenMessage = buildTerminalViewportMessage({
      visible: false,
      measuredViewport: null,
      localViewport: null,
      appliedViewport: { cols: 90, rows: 30 },
    });

    expect(hiddenMessage.message).toEqual({
      type: "resize",
      cols: 90,
      rows: 30,
      visible: false,
    });
  });
});
