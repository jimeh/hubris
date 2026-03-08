import { getEventClient } from "$lib/events";
import {
  initializeProjectStore,
  resetProjectStoreForTests,
} from "$lib/stores/projects";
import {
  initializeWorktreeStore,
  resetWorktreeStoreForTests,
} from "$lib/stores/worktrees";
import { initializeTabStore, resetTabStoreForTests } from "$lib/stores/tabs";
import { useThemeStore } from "$lib/stores/theme";
import { useTerminalStore } from "$lib/stores/terminal";
import { useWorktreeSettingsStore } from "$lib/stores/worktreeSettings";

let bootstrapped = false;

export function bootstrapApp(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  initializeProjectStore();
  initializeWorktreeStore();
  initializeTabStore();

  void useThemeStore.getState().init();
  void useTerminalStore.getState().init();
  void useWorktreeSettingsStore.getState().init();

  getEventClient().connect();
}

export function resetBootstrapForTests(): void {
  bootstrapped = false;
  resetProjectStoreForTests();
  resetWorktreeStoreForTests();
  resetTabStoreForTests();
  getEventClient().disconnect();
}
