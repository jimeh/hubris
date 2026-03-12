import { vi } from "vitest";

let currentMatches = false;
let listeners = new Set<(event: MediaQueryListEvent) => void>();
let matchMediaMock: ((query: string) => MediaQueryList) | null = null;

function installMatchMediaMock(): void {
  listeners = new Set<(event: MediaQueryListEvent) => void>();
  matchMediaMock = vi.fn().mockImplementation((media: string) => ({
    matches: currentMatches,
    media,
    onchange: null,
    addEventListener: (
      event: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (event === "change") {
        listeners.add(listener);
      }
    },
    removeEventListener: (
      event: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (event === "change") {
        listeners.delete(listener);
      }
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("matchMedia", matchMediaMock);
}

export function setMobile(matches: boolean): void {
  currentMatches = matches;
  window.innerWidth = matches ? 640 : 1280;
  if (window.matchMedia !== matchMediaMock) {
    installMatchMediaMock();
  }

  const event = {
    matches,
    media: "(max-width: 767px)",
  } as MediaQueryListEvent;
  for (const listener of listeners) {
    listener(event);
  }
}
