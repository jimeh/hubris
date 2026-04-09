import { vi } from "vitest";

type LegacyMediaQueryListener = (
  this: MediaQueryList,
  ev: MediaQueryListEvent,
) => void;
type MediaQueryListener =
  | EventListenerOrEventListenerObject
  | LegacyMediaQueryListener;
type QueryState = {
  matches: boolean;
  listeners: Set<MediaQueryListener>;
};

let currentViewportWidth = 1280;
let queryStates = new Map<string, QueryState>();
let matchMediaMock: ((query: string) => MediaQueryList) | null = null;

function evaluateMediaQuery(query: string): boolean {
  const maxWidthMatch = query.match(/max-width:\s*(\d+)px/);
  const minWidthMatch = query.match(/min-width:\s*(\d+)px/);

  let matches = true;
  if (maxWidthMatch) {
    matches &&= currentViewportWidth <= Number.parseInt(maxWidthMatch[1], 10);
  }
  if (minWidthMatch) {
    matches &&= currentViewportWidth >= Number.parseInt(minWidthMatch[1], 10);
  }

  if (maxWidthMatch || minWidthMatch) {
    return matches;
  }

  return false;
}

function getQueryState(query: string): QueryState {
  let state = queryStates.get(query);
  if (!state) {
    state = {
      matches: evaluateMediaQuery(query),
      listeners: new Set<MediaQueryListener>(),
    };
    queryStates.set(query, state);
  }
  return state;
}

function dispatchListener(
  listener: MediaQueryListener,
  target: MediaQueryList,
  event: MediaQueryListEvent,
): void {
  if (typeof listener === "function") {
    listener.call(target, event);
    return;
  }

  listener.handleEvent(event);
}

function installMatchMediaMock(): void {
  queryStates = new Map<string, QueryState>();
  matchMediaMock = vi.fn().mockImplementation((media: string) => {
    const state = getQueryState(media);
    const mediaQueryList = {
      get matches() {
        return state.matches;
      },
      media,
      onchange: null,
      addEventListener: (
        event: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (event === "change") {
          state.listeners.add(listener);
        }
      },
      removeEventListener: (
        event: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (event === "change") {
          state.listeners.delete(listener);
        }
      },
      addListener: (listener: LegacyMediaQueryListener | null) => {
        if (listener) {
          state.listeners.add(listener);
        }
      },
      removeListener: (listener: LegacyMediaQueryListener | null) => {
        if (listener) {
          state.listeners.delete(listener);
        }
      },
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList;

    return mediaQueryList;
  });
  vi.stubGlobal("matchMedia", matchMediaMock);
}

export function setMobile(matches: boolean): void {
  currentViewportWidth = matches ? 640 : 1280;
  window.innerWidth = currentViewportWidth;
  if (window.matchMedia !== matchMediaMock) {
    installMatchMediaMock();
  }

  for (const [query, state] of queryStates) {
    const nextMatches = evaluateMediaQuery(query);
    if (nextMatches === state.matches) {
      continue;
    }

    state.matches = nextMatches;
    const event = {
      matches: nextMatches,
      media: query,
    } as MediaQueryListEvent;
    const target = window.matchMedia(query);
    for (const listener of state.listeners) {
      dispatchListener(listener, target, event);
    }
  }
}
