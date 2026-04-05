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

  void fetchSystemInfo().then((info) => {
    useSystemStore.setState({ homeDir: info.home_dir ?? null });
  });
}

export function resetSystemStoreForTests(): void {
  initialized = false;
  useSystemStore.setState({ homeDir: null });
}
