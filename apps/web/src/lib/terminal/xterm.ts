import { WebLinksAddon } from "@xterm/addon-web-links";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { IBufferRange, IViewportRange } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalAdapter, TerminalViewport } from "./adapter";
import { DEFAULT_FONT_FAMILY } from "./fonts";
import { getTerminalTheme } from "./theme";

const LINK_TOOLTIP_DELAY_MS = 500;
const LINK_TOOLTIP_HIDE_DELAY_MS = 120;
const LINK_TOOLTIP_OFFSET_PX = 18;
const LINK_TOOLTIP_MARGIN_PX = 8;

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

type LinkTooltipAnchor = {
  uri: string;
  range: IViewportRange;
};

function openTerminalLink(uri: string) {
  window.open(uri, "_blank", "noopener,noreferrer");
}

function isMacPlatform(): boolean {
  const navigatorWithPlatform = navigator as NavigatorWithUserAgentData;
  const platform =
    navigatorWithPlatform.userAgentData?.platform ?? navigator.platform ?? "";
  return /mac/i.test(platform);
}

function followLinkModifierLabel(): "Cmd" | "Ctrl" {
  return isMacPlatform() ? "Cmd" : "Ctrl";
}

function shouldFollowTerminalLink(event: MouseEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function toViewportRange(term: Terminal, range: IBufferRange): IViewportRange {
  const viewportY = term.buffer.active.viewportY;
  return {
    start: {
      x: range.start.x - 1,
      y: range.start.y - viewportY - 1,
    },
    end: {
      x: range.end.x - 1,
      y: range.end.y - viewportY - 1,
    },
  };
}

class TerminalLinkTooltipController {
  private readonly wrapper: HTMLElement;
  private readonly term: Terminal;
  private readonly tooltip = document.createElement("div");
  private readonly tooltipBody = document.createElement("div");
  private readonly tooltipHeader = document.createElement("div");
  private readonly followLinkButton = document.createElement("button");
  private readonly modifierHint = document.createElement("span");
  private readonly uriLabel = document.createElement("code");
  private readonly onTooltipEnter = () => {
    this.clearHideTimer();
  };
  private readonly onTooltipLeave = () => {
    this.scheduleHide();
  };
  private hoverTimer: number | null = null;
  private hideTimer: number | null = null;
  private anchor: LinkTooltipAnchor | null = null;
  private currentUri: string | null = null;

  constructor(wrapper: HTMLElement, term: Terminal) {
    this.wrapper = wrapper;
    this.term = term;
    this.tooltip.className =
      "xterm-hover pointer-events-auto absolute z-50 max-w-sm rounded-md " +
      "border border-border bg-popover px-3 py-2 text-xs " +
      "text-popover-foreground shadow-md";
    this.tooltip.hidden = true;
    this.tooltipBody.className = "flex flex-col gap-1";
    this.tooltipHeader.className =
      "flex items-center justify-center gap-1.5 text-center";

    this.followLinkButton.type = "button";
    this.followLinkButton.className =
      "cursor-pointer rounded-sm text-center font-medium text-primary underline " +
      "decoration-primary/50 underline-offset-2 transition-colors " +
      "hover:text-primary/80 hover:decoration-primary focus-visible:outline-none " +
      "focus-visible:ring-2 focus-visible:ring-ring";
    this.followLinkButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.currentUri) {
        return;
      }

      openTerminalLink(this.currentUri);
      this.hide();
    });

    this.modifierHint.className = "text-muted-foreground";
    this.uriLabel.className =
      "max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-sm " +
      "bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

    this.tooltipHeader.append(this.followLinkButton, this.modifierHint);
    this.tooltipBody.append(this.tooltipHeader, this.uriLabel);
    this.tooltip.append(this.tooltipBody);
    this.tooltip.addEventListener("mouseenter", this.onTooltipEnter);
    this.tooltip.addEventListener("mouseleave", this.onTooltipLeave);
    this.wrapper.appendChild(this.tooltip);
  }

  scheduleShow(uri: string, range: IViewportRange) {
    this.clearHideTimer();

    const anchor = {
      uri,
      range,
    };

    if (!this.tooltip.hidden && this.currentUri === uri) {
      this.anchor = anchor;
      this.render(range);
      return;
    }

    this.anchor = anchor;
    this.currentUri = uri;
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      this.render(anchor.range);
    }, LINK_TOOLTIP_DELAY_MS);
  }

  scheduleHide() {
    this.clearHoverTimer();
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, LINK_TOOLTIP_HIDE_DELAY_MS);
  }

  hide() {
    this.clearHoverTimer();
    this.clearHideTimer();
    this.anchor = null;
    this.currentUri = null;
    this.tooltip.hidden = true;
  }

  dispose() {
    this.hide();
    this.tooltip.removeEventListener("mouseenter", this.onTooltipEnter);
    this.tooltip.removeEventListener("mouseleave", this.onTooltipLeave);
    this.tooltip.remove();
  }

  private clearHoverTimer() {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private clearHideTimer() {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private render(range: IViewportRange) {
    if (!this.anchor || !this.currentUri) {
      return;
    }

    this.followLinkButton.textContent = "Follow link";
    this.modifierHint.textContent = `(${followLinkModifierLabel()}+click)`;
    this.uriLabel.textContent = this.currentUri;
    this.tooltip.hidden = false;

    const wrapperRect = this.wrapper.getBoundingClientRect();
    const screen =
      this.term.element?.querySelector(".xterm-screen") ??
      this.term.element ??
      this.wrapper;
    const screenRect = screen.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const cellWidth =
      this.term.cols > 0 ? screenRect.width / this.term.cols : 0;
    const cellHeight =
      this.term.rows > 0 ? screenRect.height / this.term.rows : 0;
    const linkLeft =
      screenRect.left -
      wrapperRect.left +
      Math.max(0, range.start.x) * cellWidth;
    const linkRight =
      screenRect.left -
      wrapperRect.left +
      Math.min(this.term.cols, Math.max(range.start.x, range.end.x)) *
        cellWidth;
    const linkTop =
      screenRect.top -
      wrapperRect.top +
      Math.max(0, range.start.y) * cellHeight;
    const linkBottom =
      screenRect.top -
      wrapperRect.top +
      Math.min(this.term.rows, range.end.y + 1) * cellHeight;
    const anchorX = (linkLeft + Math.max(linkLeft + cellWidth, linkRight)) / 2;
    const maxLeft = Math.max(
      LINK_TOOLTIP_MARGIN_PX,
      wrapperRect.width - tooltipRect.width - LINK_TOOLTIP_MARGIN_PX,
    );
    const left = Math.min(
      Math.max(anchorX - tooltipRect.width / 2, LINK_TOOLTIP_MARGIN_PX),
      maxLeft,
    );

    let top = linkTop - tooltipRect.height - LINK_TOOLTIP_OFFSET_PX;
    if (top < LINK_TOOLTIP_MARGIN_PX) {
      top = Math.min(
        linkBottom + LINK_TOOLTIP_OFFSET_PX,
        Math.max(
          LINK_TOOLTIP_MARGIN_PX,
          wrapperRect.height - tooltipRect.height - LINK_TOOLTIP_MARGIN_PX,
        ),
      );
    }

    this.tooltip.style.left = `${Math.round(left)}px`;
    this.tooltip.style.top = `${Math.round(
      Math.max(LINK_TOOLTIP_MARGIN_PX, top),
    )}px`;
  }
}

export function createXtermAdapter(opts?: {
  fontSize?: number;
  fontFamily?: string;
}): TerminalAdapter {
  const term = new Terminal({
    fontSize: opts?.fontSize ?? 14,
    fontFamily: opts?.fontFamily ?? DEFAULT_FONT_FAMILY,
    theme: getTerminalTheme(),
    cursorBlink: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  let contextLossSubscription: { dispose(): void } | null = null;
  let linkTooltipController: TerminalLinkTooltipController | null = null;

  return {
    open(container: HTMLElement) {
      term.open(container);
      term.loadAddon(fitAddon);

      const tooltipContainer =
        container.parentElement instanceof HTMLElement
          ? container.parentElement
          : container;
      linkTooltipController = new TerminalLinkTooltipController(
        tooltipContainer,
        term,
      );

      const activateTerminalLink = (event: MouseEvent, uri: string) => {
        if (!shouldFollowTerminalLink(event)) {
          return;
        }

        event.preventDefault();
        openTerminalLink(uri);
      };
      const hideTerminalLinkTooltip = () => {
        linkTooltipController?.scheduleHide();
      };
      const terminalLinkHandler = {
        activate(event: MouseEvent, uri: string) {
          activateTerminalLink(event, uri);
        },
        hover(_event: MouseEvent, uri: string, range: IBufferRange) {
          linkTooltipController?.scheduleShow(
            uri,
            toViewportRange(term, range),
          );
        },
        leave() {
          hideTerminalLinkTooltip();
        },
        allowNonHttpProtocols: false,
      };
      term.options.linkHandler = terminalLinkHandler;

      term.loadAddon(
        new WebLinksAddon(activateTerminalLink, {
          hover(_event, uri, range) {
            linkTooltipController?.scheduleShow(uri, range);
          },
          leave() {
            hideTerminalLinkTooltip();
          },
        }),
      );

      try {
        const webgl = new WebglAddon();
        contextLossSubscription = webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch {
        // WebGL not available, use default canvas
      }
    },
    write(data: string | Uint8Array) {
      term.write(data);
    },
    onData(cb: (data: string) => void) {
      return term.onData(cb);
    },
    onBinary(cb: (data: string) => void) {
      return term.onBinary(cb);
    },
    resize(cols: number, rows: number) {
      term.resize(cols, rows);
    },
    measureViewport(): TerminalViewport | null {
      const viewport = fitAddon.proposeDimensions();
      if (!viewport) {
        return null;
      }

      return {
        cols: viewport.cols,
        rows: viewport.rows,
      };
    },
    get rows() {
      return term.rows;
    },
    get cols() {
      return term.cols;
    },
    focus() {
      term.focus();
    },
    clear() {
      term.reset();
    },
    refreshTheme() {
      term.options.theme = getTerminalTheme();
    },
    updateFont(family: string, size: number) {
      term.options.fontFamily = family;
      term.options.fontSize = size;
    },
    dispose() {
      contextLossSubscription?.dispose();
      contextLossSubscription = null;
      linkTooltipController?.dispose();
      linkTooltipController = null;
      term.dispose();
    },
  };
}
