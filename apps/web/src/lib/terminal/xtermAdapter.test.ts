// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXtermAdapter } from "./xterm";

type WebLinksAddonOptions = {
  hover?: (
    event: MouseEvent,
    text: string,
    range: { start: { x: number; y: number }; end: { x: number; y: number } },
  ) => void;
  leave?: (
    event: MouseEvent,
    text: string,
    range: { start: { x: number; y: number }; end: { x: number; y: number } },
  ) => void;
  allowNonHttpProtocols?: boolean;
};

type LinkRange = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

type TerminalLinkHandler = {
  activate: (event: MouseEvent, text: string, range: LinkRange) => void;
  hover?: (event: MouseEvent, text: string, range: LinkRange) => void;
  leave?: (event: MouseEvent, text: string, range: LinkRange) => void;
  allowNonHttpProtocols?: boolean;
};

let currentViewportY = 0;

const {
  terminalInstances,
  fitAddonInstances,
  webLinksAddonHandlers,
  webLinksAddonOptions,
  MockTerminal,
  MockFitAddon,
} = vi.hoisted(() => {
  const terminalInstances: MockTerminal[] = [];
  const fitAddonInstances: MockFitAddon[] = [];
  const webLinksAddonHandlers: Array<
    ((event: MouseEvent, uri: string) => void) | undefined
  > = [];
  const webLinksAddonOptions: WebLinksAddonOptions[] = [];

  class MockTerminal {
    options: Record<string, unknown>;
    element?: HTMLElement;
    rows = 24;
    cols = 80;
    buffer = {
      active: {
        get viewportY() {
          return currentViewportY;
        },
      },
    };
    loadAddon = vi.fn();
    open = vi.fn((container: HTMLElement) => {
      this.element = container;
    });
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
    webLinksAddonHandlers,
    webLinksAddonOptions,
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
  WebLinksAddon: class MockWebLinksAddon {
    constructor(
      handler?: (event: MouseEvent, uri: string) => void,
      options?: WebLinksAddonOptions,
    ) {
      webLinksAddonHandlers.push(handler);
      webLinksAddonOptions.push(options ?? {});
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss() {}

    dispose() {}
  },
}));

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

function mountTerminalContainer() {
  const wrapper = document.createElement("div");
  const container = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  wrapper.appendChild(container);
  container.appendChild(screen);
  document.body.appendChild(wrapper);
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 480,
    bottom: 320,
    width: 480,
    height: 320,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 16,
    top: 16,
    left: 20,
    right: 420,
    bottom: 256,
    width: 400,
    height: 240,
    toJSON: () => ({}),
  } as DOMRect);

  return { wrapper, container, screen };
}

function getTooltip() {
  return document.body.querySelector("div.bg-popover") as HTMLDivElement | null;
}

function getTerminalLinkHandler() {
  return terminalInstances[0]?.options.linkHandler as
    | TerminalLinkHandler
    | undefined;
}

describe("createXtermAdapter", () => {
  beforeEach(() => {
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    webLinksAddonHandlers.length = 0;
    webLinksAddonOptions.length = 0;
    currentViewportY = 0;
    setNavigatorPlatform("MacIntel");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns proposed viewport dimensions without fitting locally", () => {
    const adapter = createXtermAdapter();

    expect(adapter.measureViewport()).toEqual({ cols: 132, rows: 41 });
  });

  it("clamps tiny proposed viewport dimensions", () => {
    const adapter = createXtermAdapter();
    fitAddonInstances[0].proposeDimensions.mockReturnValue({
      cols: 0,
      rows: 0,
    });

    expect(adapter.measureViewport()).toEqual({ cols: 8, rows: 2 });
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

  it("requires Cmd+click on macOS terminal links", () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    webLinksAddonHandlers[0]?.(
      new MouseEvent("click"),
      "https://example.com/cmd",
    );
    webLinksAddonHandlers[0]?.(
      new MouseEvent("click", { metaKey: true }),
      "https://example.com/cmd",
    );

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/cmd",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("requires Ctrl+click on non-macOS terminal links", () => {
    setNavigatorPlatform("Linux x86_64");
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    webLinksAddonHandlers[0]?.(
      new MouseEvent("click", { metaKey: true }),
      "https://example.com/ctrl",
    );
    webLinksAddonHandlers[0]?.(
      new MouseEvent("click", { ctrlKey: true }),
      "https://example.com/ctrl",
    );

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/ctrl",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("configures a shared xterm link handler with HTTP-only schemes", () => {
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);

    expect(getTerminalLinkHandler()).toMatchObject({
      activate: expect.any(Function),
      hover: expect.any(Function),
      leave: expect.any(Function),
      allowNonHttpProtocols: false,
    });
  });

  it("requires Cmd+click on OSC 8 links", () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    const linkHandler = getTerminalLinkHandler();

    linkHandler?.activate(new MouseEvent("click"), "https://example.com/osc8", {
      start: { x: 2, y: 3 },
      end: { x: 12, y: 3 },
    });
    linkHandler?.activate(
      new MouseEvent("click", { metaKey: true }),
      "https://example.com/osc8",
      {
        start: { x: 2, y: 3 },
        end: { x: 12, y: 3 },
      },
    );

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/osc8",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows a delayed tooltip above hovered links", () => {
    vi.useFakeTimers();
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    const tooltip = getTooltip();
    expect(tooltip?.hidden).toBe(true);
    vi.spyOn(tooltip!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 140,
      bottom: 28,
      width: 140,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect);

    webLinksAddonOptions[0]?.hover?.(
      new MouseEvent("mousemove", { clientX: 160, clientY: 140 }),
      "https://example.com/docs",
      {
        start: { x: 4, y: 8 },
        end: { x: 18, y: 8 },
      },
    );

    expect(getTooltip()?.hidden).toBe(true);

    vi.advanceTimersByTime(500);

    const renderedTooltip = getTooltip();

    expect(renderedTooltip?.hidden).toBe(false);
    expect(document.body.textContent).toContain("Follow link");
    expect(document.body.textContent).toContain("(Cmd+click)");
    expect(document.body.textContent).toContain("https://example.com/docs");
    expect(renderedTooltip).not.toBeNull();
    expect(renderedTooltip?.className).toContain("bg-popover");
    expect(renderedTooltip?.className).toContain("absolute");
    expect(renderedTooltip?.className).toContain("xterm-hover");
    expect(
      Number.parseInt(renderedTooltip?.style.top ?? "999", 10),
    ).toBeLessThan(96);
  });

  it("opens the hovered link from the tooltip without a modifier", () => {
    vi.useFakeTimers();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    webLinksAddonOptions[0]?.hover?.(
      new MouseEvent("mousemove", { clientX: 200, clientY: 120 }),
      "https://example.com/tooltip",
      {
        start: { x: 6, y: 4 },
        end: { x: 16, y: 4 },
      },
    );

    vi.advanceTimersByTime(500);

    const button = document.body.querySelector("button");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/tooltip",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows the destination URI for hovered OSC 8 links", () => {
    vi.useFakeTimers();
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    const tooltip = getTooltip();
    expect(tooltip?.hidden).toBe(true);
    vi.spyOn(tooltip!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 156,
      bottom: 44,
      width: 156,
      height: 44,
      toJSON: () => ({}),
    } as DOMRect);

    const linkHandler = getTerminalLinkHandler();
    linkHandler?.hover?.(
      new MouseEvent("mousemove", { clientX: 160, clientY: 140 }),
      "https://example.com/rich",
      {
        start: { x: 8, y: 6 },
        end: { x: 14, y: 6 },
      },
    );

    vi.advanceTimersByTime(500);

    expect(getTooltip()?.hidden).toBe(false);
    expect(document.body.textContent).toContain("https://example.com/rich");

    linkHandler?.leave?.(
      new MouseEvent("mouseleave"),
      "https://example.com/rich",
      {
        start: { x: 8, y: 6 },
        end: { x: 14, y: 6 },
      },
    );
    vi.advanceTimersByTime(120);

    expect(getTooltip()?.hidden).toBe(true);
  });

  it("converts OSC 8 hover coordinates from buffer space to viewport space", () => {
    vi.useFakeTimers();
    currentViewportY = 40;
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    const tooltip = getTooltip();
    expect(tooltip?.hidden).toBe(true);
    vi.spyOn(tooltip!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 156,
      bottom: 44,
      width: 156,
      height: 44,
      toJSON: () => ({}),
    } as DOMRect);

    const linkHandler = getTerminalLinkHandler();
    linkHandler?.hover?.(
      new MouseEvent("mousemove", { clientX: 160, clientY: 140 }),
      "https://example.com/scrollback",
      {
        start: { x: 3, y: 45 },
        end: { x: 8, y: 45 },
      },
    );

    vi.advanceTimersByTime(500);

    const renderedTooltip = getTooltip();
    const osc8Left = renderedTooltip?.style.left;
    const osc8Top = renderedTooltip?.style.top;

    expect(renderedTooltip?.hidden).toBe(false);

    linkHandler?.leave?.(
      new MouseEvent("mouseleave"),
      "https://example.com/scrollback",
      {
        start: { x: 3, y: 45 },
        end: { x: 8, y: 45 },
      },
    );
    vi.advanceTimersByTime(120);

    webLinksAddonOptions[0]?.hover?.(
      new MouseEvent("mousemove", { clientX: 160, clientY: 140 }),
      "https://example.com/viewport",
      {
        start: { x: 2, y: 4 },
        end: { x: 8, y: 4 },
      },
    );
    vi.advanceTimersByTime(500);

    const viewportTooltip = getTooltip();

    expect(viewportTooltip?.hidden).toBe(false);
    expect(viewportTooltip?.style.left).toBe(osc8Left);
    expect(viewportTooltip?.style.top).toBe(osc8Top);
  });

  it("cancels the delayed tooltip when leaving early", () => {
    vi.useFakeTimers();
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    webLinksAddonOptions[0]?.hover?.(
      new MouseEvent("mousemove", { clientX: 140, clientY: 100 }),
      "https://example.com/cancel",
      {
        start: { x: 5, y: 2 },
        end: { x: 12, y: 2 },
      },
    );
    webLinksAddonOptions[0]?.leave?.(
      new MouseEvent("mouseleave"),
      "https://example.com/cancel",
      {
        start: { x: 5, y: 2 },
        end: { x: 12, y: 2 },
      },
    );

    vi.advanceTimersByTime(500);

    expect(getTooltip()?.hidden).toBe(true);
  });

  it("removes the tooltip and clears timers on dispose", () => {
    vi.useFakeTimers();
    const adapter = createXtermAdapter();
    const { container } = mountTerminalContainer();

    adapter.open(container);
    webLinksAddonOptions[0]?.hover?.(
      new MouseEvent("mousemove", { clientX: 140, clientY: 100 }),
      "https://example.com/dispose",
      {
        start: { x: 5, y: 2 },
        end: { x: 12, y: 2 },
      },
    );

    adapter.dispose();
    vi.advanceTimersByTime(500);

    expect(getTooltip()).toBeNull();
  });
});
