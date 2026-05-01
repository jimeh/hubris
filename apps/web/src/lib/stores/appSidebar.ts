import { create } from "zustand";

type AppSidebarController = {
  toggle: () => void;
};

type AppSidebarState = {
  controller: AppSidebarController | null;
  clearController: (controller: AppSidebarController) => void;
  setController: (controller: AppSidebarController) => void;
  toggle: () => boolean;
};

/** Tracks the app shell sidebar controller used by command handlers. */
export const useAppSidebarStore = create<AppSidebarState>((set, get) => ({
  controller: null,
  clearController(controller) {
    set((state) =>
      state.controller === controller ? { controller: null } : state,
    );
  },
  setController(controller) {
    set({ controller });
  },
  toggle() {
    const controller = get().controller;
    if (!controller) {
      return false;
    }
    controller.toggle();
    return true;
  },
}));

/** Resets app sidebar command state between tests. */
export function resetAppSidebarStoreForTests(): void {
  useAppSidebarStore.setState({ controller: null });
}
