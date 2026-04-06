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
  initializeFileEditorStore,
  resetFileEditorStoreForTests,
} from "@/lib/stores/fileEditorTabs";
import {
  initializeGitDiffStore,
  resetGitDiffStoreForTests,
} from "@/lib/stores/gitDiffTabs";
import {
  initializeWorktreeFileManagerStore,
  resetWorktreeFileManagerStoreForTests,
} from "@/lib/stores/worktreeFileManager";
import {
  initializeWorktreeRightSidebarStore,
  resetWorktreeRightSidebarStoreForTests,
} from "@/lib/stores/worktreeRightSidebar";
import {
  initializeSettingsStore,
  resetSettingsStoreForTests,
} from "@/lib/stores/settings";
import {
  initializeSystemStore,
  resetSystemStoreForTests,
} from "@/lib/stores/system";

let bootstrapped = false;

export function bootstrapApp(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  initializeProjectStore();
  initializeWorktreeStore();
  initializeTabStore();
  initializeFileEditorStore();
  initializeGitDiffStore();
  initializeWorktreeFileManagerStore();
  initializeWorktreeRightSidebarStore();
  initializeSettingsStore();
  initializeSystemStore();

  getEventClient().connect();
}

export function resetBootstrapForTests(): void {
  bootstrapped = false;
  resetProjectStoreForTests();
  resetWorktreeStoreForTests();
  resetTabStoreForTests();
  resetFileEditorStoreForTests();
  resetGitDiffStoreForTests();
  resetWorktreeFileManagerStoreForTests();
  resetWorktreeRightSidebarStoreForTests();
  resetSettingsStoreForTests();
  resetSystemStoreForTests();
  getEventClient().disconnect();
}
