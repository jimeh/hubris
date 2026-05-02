import type { components } from "@/lib/contracts/rest.generated";

export type Project = components["schemas"]["Project"];
export type Worktree = components["schemas"]["Worktree"];
export type Tab = components["schemas"]["TabInfo"];
export type TerminalTab = Extract<Tab, { type: "terminal" }>;
export type FileTab = Extract<Tab, { type: "file" }>;
export type GitDiffTab = Extract<Tab, { type: "git_diff" }>;
export type BrowserTab = Extract<Tab, { type: "browser" }>;
export type AgentChatTab = Extract<Tab, { type: "agent_chat" }>;
export type TabPaneSplitAxis = components["schemas"]["TabPaneSplitAxis"];
export type WorktreePaneNode = components["schemas"]["WorktreePaneNode"];
export type WorktreePaneTabs = components["schemas"]["WorktreePaneTabs"];
export type WorktreeTabLayout = components["schemas"]["WorktreeTabLayout"];
export type WorktreeTabLayoutState =
  components["schemas"]["WorktreeTabLayoutState"];
export type DirEntry = components["schemas"]["DirEntry"];
export type ListFilesResponse = components["schemas"]["ListFilesResponse"];
export type WorktreeFileKind = components["schemas"]["WorktreeFileKind"];
export type WorktreeFileEntry = components["schemas"]["WorktreeFileEntry"];
export type ListWorktreeFilesResponse =
  components["schemas"]["ListWorktreeFilesResponse"];
export type RenameWorktreeFileResponse =
  components["schemas"]["RenameWorktreeFileResponse"];
export type GitDiffScope = components["schemas"]["GitDiffScope"];
export type WorktreeFileContentResponse =
  components["schemas"]["WorktreeFileContentResponse"];
export type WorktreeGitDiffResponse =
  components["schemas"]["WorktreeGitDiffResponse"];
export type SystemInfo = components["schemas"]["SystemInfo"];
export type ChatConversationSummary =
  components["schemas"]["ChatConversationSummary"];
export type ChatConversationDetail =
  components["schemas"]["ChatConversationDetail"];
export type ChatConversationSettingsPatch =
  components["schemas"]["ChatConversationSettingsPatch"];
export type ChatMessage = components["schemas"]["ChatMessage"];
export type ChatTurn = components["schemas"]["ChatTurn"];
export type ChatItem = components["schemas"]["ChatItem"];
export type ChatItemOutput = components["schemas"]["ChatItemOutput"];
export type ChatActivityDetail = components["schemas"]["ChatActivityDetail"];
export type ChatModelOption = components["schemas"]["ChatModelOption"];
export type ChatModelReasoningEffortOption =
  components["schemas"]["ChatModelReasoningEffortOption"];
export type ChatPermissionMode = components["schemas"]["ChatPermissionMode"];
export type ChatRun = components["schemas"]["ChatRun"];
export type ChatRuntimeStatus = components["schemas"]["ChatRuntimeStatus"];
export type ChatAppServerStatus = components["schemas"]["ChatAppServerStatus"];
export type ChatThreadStreamStatus =
  components["schemas"]["ChatThreadStreamStatus"];
export type ChatMessageRole = components["schemas"]["ChatMessageRole"];
export type ChatMessageStatus = components["schemas"]["ChatMessageStatus"];
export type ChatReasoningEffort = components["schemas"]["ChatReasoningEffort"];
export type ChatRunStatus = components["schemas"]["ChatRunStatus"];
export type ChatTurnStatus = components["schemas"]["ChatTurnStatus"];
export type ChatItemKind = components["schemas"]["ChatItemKind"];
export type ChatItemStatus = components["schemas"]["ChatItemStatus"];
export type ChatRuntimeLifecycle =
  components["schemas"]["ChatRuntimeLifecycle"];
