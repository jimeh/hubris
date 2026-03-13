import { getEventClient } from "@/lib/events";
import {
  initializeProjectStore,
  resetProjectStoreForTests,
} from "@/lib/stores/projects";
import {
  initializeWorktreeStore,
  resetWorktreeStoreForTests,
} from "@/lib/stores/worktrees";
import { initializeTabStore, resetTabStoreForTests } from "@/lib/stores/tabs";
import {
  initializeSettingsStore,
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import { useThemeStore } from "@/lib/stores/theme";
import { useTerminalStore } from "@/lib/stores/terminal";

let bootstrapped = false;

export function bootstrapApp(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  initializeProjectStore();
  initializeWorktreeStore();
  initializeTabStore();
  initializeSettingsStore();

  void useSettingsStore.getState().init();
  void useThemeStore.getState().init();
  void useTerminalStore.getState().init();

  getEventClient().connect();
}

export function resetBootstrapForTests(): void {
  bootstrapped = false;
  resetProjectStoreForTests();
  resetWorktreeStoreForTests();
  resetTabStoreForTests();
  resetSettingsStoreForTests();
  getEventClient().disconnect();
}
