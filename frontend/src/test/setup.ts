import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

function consumeClipboardItems(items: unknown[]): void {
  for (const item of items) {
    if (!item || typeof item !== "object" || !("items" in item)) {
      continue;
    }

    for (const value of Object.values(
      (item as { items: Record<string, Promise<unknown> | unknown> }).items,
    )) {
      Promise.resolve(value).catch(() => {});
    }
  }
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query.includes("dark"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(Element.prototype, "hasPointerCapture", {
  writable: true,
  value: () => false,
});

Object.defineProperty(Element.prototype, "setPointerCapture", {
  writable: true,
  value: () => {},
});

Object.defineProperty(Element.prototype, "releasePointerCapture", {
  writable: true,
  value: () => {},
});

Object.defineProperty(Element.prototype, "scrollIntoView", {
  writable: true,
  value: () => {},
});

Object.defineProperty(document, "queryCommandSupported", {
  writable: true,
  value: () => false,
});

Object.defineProperty(window.navigator, "clipboard", {
  configurable: true,
  writable: true,
  value: {
    write: (items: unknown[]) => {
      consumeClipboardItems(items);
      return Promise.resolve();
    },
    read: () => Promise.resolve([]),
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(""),
  },
});

class ClipboardItemMock {
  items: Record<string, Promise<Blob> | Blob>;

  constructor(items: Record<string, Promise<Blob> | Blob>) {
    this.items = items;
  }
}

Object.defineProperty(window, "ClipboardItem", {
  writable: true,
  value: ClipboardItemMock,
});
