import { create } from "zustand";

type BrowserSurfaceOcclusionState = {
  reasons: Record<string, true>;
  setReason: (reason: string, open: boolean) => void;
};

export const useBrowserSurfaceOcclusionStore =
  create<BrowserSurfaceOcclusionState>((set) => ({
    reasons: {},
    setReason(reason, open) {
      set((state) => {
        const reasons = { ...state.reasons };
        if (open) {
          reasons[reason] = true;
        } else {
          delete reasons[reason];
        }
        return { reasons };
      });
    },
  }));

export function isBrowserSurfaceOccluded(): boolean {
  return (
    Object.keys(useBrowserSurfaceOcclusionStore.getState().reasons).length > 0
  );
}

export function resetBrowserSurfaceOcclusionStoreForTests(): void {
  useBrowserSurfaceOcclusionStore.setState({ reasons: {} });
}
