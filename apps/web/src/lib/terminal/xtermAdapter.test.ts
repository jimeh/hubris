// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXtermAdapter } from "./xterm";

const { terminalInstances, fitAddonInstances, MockTerminal, MockFitAddon } =
  vi.hoisted(() => {
    const terminalInstances: MockTerminal[] = [];
    const fitAddonInstances: MockFitAddon[] = [];

    class MockTerminal {
      options: Record<string, unknown>;
      rows = 24;
      cols = 80;
      loadAddon = vi.fn();
      open = vi.fn();
      write = vi.fn();
      onData = vi.fn(() => ({ dispose: vi.fn() }));
      onBinary = vi.fn(() => ({ dispose: vi.fn() }));
      resize = vi.fn();
      focus = vi.fn();
      reset = vi.fn();
      dispose = vi.fn();

      constructor(options: Record<string, unknown>) {
        this.options = options;
        terminalInstances.push(this);
      }
    }

    class MockFitAddon {
      proposeDimensions = vi.fn(() => ({ cols: 132, rows: 41 }));

      constructor() {
        fitAddonInstances.push(this);
      }
    }

    return {
      terminalInstances,
      fitAddonInstances,
      MockTerminal,
      MockFitAddon,
    };
  });

vi.mock("@xterm/xterm", () => ({
  Terminal: MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss() {}

    dispose() {}
  },
}));

describe("createXtermAdapter", () => {
  beforeEach(() => {
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
  });

  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("returns proposed viewport dimensions without fitting locally", () => {
    const adapter = createXtermAdapter();

    expect(adapter.measureViewport()).toEqual({ cols: 132, rows: 41 });
  });

  it("updates font without forcing a local fit", () => {
    const adapter = createXtermAdapter();
    const terminal = terminalInstances[0];
    const fitAddon = fitAddonInstances[0];

    adapter.updateFont("Fira Code", 16);

    expect(terminal.options.fontFamily).toBe("Fira Code");
    expect(terminal.options.fontSize).toBe(16);
    expect(fitAddon.proposeDimensions).not.toHaveBeenCalled();
  });

  it("exposes xterm binary input events", () => {
    const adapter = createXtermAdapter();
    const terminal = terminalInstances[0];
    const onBinary = vi.fn();

    adapter.onBinary(onBinary);

    expect(terminal.onBinary).toHaveBeenCalledWith(onBinary);
  });
});
