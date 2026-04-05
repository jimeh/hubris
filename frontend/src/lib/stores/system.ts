import { create } from "zustand";
import { fetchSystemInfo } from "@/lib/api";

type SystemState = {
  homeDir: string | null;
};

export const useSystemStore = create<SystemState>(() => ({
  homeDir: null,
}));

let initialized = false;

export function initializeSystemStore(): void {
  if (initialized) return;
  initialized = true;

  fetchSystemInfo().then(
    (info) => {
      useSystemStore.setState({ homeDir: info.home_dir ?? null });
    },
    () => {
      console.warn("Failed to fetch system info");
    },
  );
}

export function resetSystemStoreForTests(): void {
  initialized = false;
  useSystemStore.setState({ homeDir: null });
}
