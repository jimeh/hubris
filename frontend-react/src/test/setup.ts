import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

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
