import type { VscodeThemeJson } from "@/lib/api";
import type { HubrisTheme } from "@/lib/theme/types";
import type { Tab } from "@/lib/types";

// Lazy indirection over `@/lib/monaco` so boot-path code (the tab
// store and App-level theme sync) never pulls the multi-MB Monaco
// bundle into the eager entry chunk. `@/lib/monaco` registers its
// bridge here when its chunk is loaded by an editor surface; until
// then these helpers are inert no-ops.

type MonacoBridge = {
  applyMonacoTheme: (
    theme: HubrisTheme | null,
    editorThemeData?: VscodeThemeJson | null,
  ) => void;
  scheduleDisposeTabModels: (tab: Tab) => void;
};

let bridge: MonacoBridge | null = null;
let latestTheme: {
  theme: HubrisTheme | null;
  editorThemeData: VscodeThemeJson | null;
} | null = null;

/**
 * Called by `@/lib/monaco` at module evaluation so deferred calls
 * route to the real implementation once Monaco has loaded. Replays
 * the most recent theme immediately so editors mount with the
 * current theme even though pre-load theme updates were dropped.
 */
export function registerMonacoBridge(next: MonacoBridge): void {
  bridge = next;
  if (latestTheme) {
    next.applyMonacoTheme(latestTheme.theme, latestTheme.editorThemeData);
  }
}

/**
 * Record the desired Monaco theme and apply it if Monaco is already
 * loaded. Never forces the Monaco chunk to load; the latest theme is
 * replayed when it does.
 */
export function applyMonacoTheme(
  theme: HubrisTheme | null,
  editorThemeData: VscodeThemeJson | null = null,
): void {
  latestTheme = { theme, editorThemeData };
  bridge?.applyMonacoTheme(theme, editorThemeData);
}

/**
 * Dispose Monaco models for a closed tab. No-op when Monaco has not
 * loaded, in which case no models exist to dispose.
 */
export function scheduleDisposeTabModels(tab: Tab): void {
  bridge?.scheduleDisposeTabModels(tab);
}

/**
 * Reset lazy bridge state for tests.
 */
export function resetMonacoLazyForTests(): void {
  bridge = null;
  latestTheme = null;
}
