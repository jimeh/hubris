import { getEventClient } from "@/lib/events";
import {
  initializeBrowserTabStore,
  resetBrowserTabStoreForTests,
} from "@/lib/stores/browserTabs";
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
  initializeVscodeStore,
  resetVscodeStoreForTests,
} from "@/lib/stores/vscode";
import {
  initializeTaskStore,
  resetTaskStoreForTests,
} from "@/lib/stores/tasks";
import {
  initializeChatStore,
  resetChatStoreForTests,
} from "@/lib/stores/chats";
import {
  initializeSettingsStore,
  resetSettingsStoreForTests,
} from "@/lib/stores/settings";
import {
  initializeKeybindingsStore,
  resetKeybindingsStoreForTests,
} from "@/lib/stores/keybindings";
import {
  initializeSystemStore,
  resetSystemStoreForTests,
} from "@/lib/stores/system";
import {
  initializeConnectionStore,
  resetConnectionStoreForTests,
} from "@/lib/stores/connection";
import { resetCommandUiStoreForTests } from "@/lib/stores/commandUi";

let bootstrapped = false;

export function bootstrapApp(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  initializeProjectStore();
  initializeWorktreeStore();
  initializeTabStore();
  initializeBrowserTabStore();
  initializeFileEditorStore();
  initializeGitDiffStore();
  initializeWorktreeFileManagerStore();
  initializeWorktreeRightSidebarStore();
  initializeTaskStore();
  initializeChatStore();
  initializeVscodeStore();
  initializeSettingsStore();
  initializeKeybindingsStore();
  initializeSystemStore();
  initializeConnectionStore();

  getEventClient().connect();
}

export function resetBootstrapForTests(): void {
  bootstrapped = false;
  resetCommandUiStoreForTests();
  resetProjectStoreForTests();
  resetWorktreeStoreForTests();
  resetTabStoreForTests();
  resetBrowserTabStoreForTests();
  resetFileEditorStoreForTests();
  resetGitDiffStoreForTests();
  resetWorktreeFileManagerStoreForTests();
  resetWorktreeRightSidebarStoreForTests();
  resetTaskStoreForTests();
  resetChatStoreForTests();
  resetVscodeStoreForTests();
  resetSettingsStoreForTests();
  resetKeybindingsStoreForTests();
  resetSystemStoreForTests();
  resetConnectionStoreForTests();
  getEventClient().disconnect();
}
