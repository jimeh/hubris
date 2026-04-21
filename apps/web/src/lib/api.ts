import type {
  GitDiffScope,
  ListFilesResponse,
  ListWorktreeFilesResponse,
  Project,
  RenameWorktreeFileResponse,
  SystemInfo,
  Tab,
  WorktreePaneNode,
  WorktreePaneTabs,
  WorktreeTabLayoutState,
  WorktreeFileContentResponse,
  WorktreeGitDiffResponse,
  Worktree,
} from "./types";
import type { components } from "@/lib/contracts/rest.generated";
import type {
  KeybindingEntry,
  KeybindingsState,
} from "@/lib/contracts/sse.generated";
import type { Settings, SettingsPatch, SettingsState } from "./theme/types";
import { apiBase, terminalWsUrlBase } from "./desktopRuntime";

const BASE = apiBase();

export class ApiStatusError extends Error {
  status: number;

  constructor(status: number, message = `${status}`) {
    super(message);
    this.name = "ApiStatusError";
    this.status = status;
  }
}

type AddProjectRequest = components["schemas"]["AddProjectRequest"];
type UpdateProjectRequest = components["schemas"]["UpdateProjectRequest"];
type ReorderProjectsRequest = components["schemas"]["ReorderProjectsRequest"];
type ListWorktreesResponse = components["schemas"]["ListWorktreesResponse"];
type StartPoint = components["schemas"]["StartPoint"];
type ListWorktreeStartPointsResponse =
  components["schemas"]["ListWorktreeStartPointsResponse"];
type CreateWorktreeRequest = components["schemas"]["CreateWorktreeRequest"];
type WorktreeGitStatusResponse =
  components["schemas"]["WorktreeGitStatusResponse"];
type GitCommitPerson = components["schemas"]["GitCommitPerson"];
type GitCommitDetailsResponse =
  components["schemas"]["GitCommitDetailsResponse"];
type WorktreeFileEntry = components["schemas"]["WorktreeFileEntry"];
type WorktreeFileKind = components["schemas"]["WorktreeFileKind"];
type GitFileChange = components["schemas"]["GitFileChange"];
type GitCommitSummary = components["schemas"]["GitCommitSummary"];
type RenameWorktreeFileRequest =
  components["schemas"]["RenameWorktreeFileRequest"];
type WorktreeGitPathActionRequest =
  components["schemas"]["WorktreeGitPathActionRequest"];
type ReorderWorktreesRequest = components["schemas"]["ReorderWorktreesRequest"];
type ListImportableWorktreesResponse =
  components["schemas"]["ListImportableWorktreesResponse"];
type ImportWorktreeRequest = components["schemas"]["ImportWorktreeRequest"];
type UpdateWorktreeRequest = components["schemas"]["UpdateWorktreeRequest"];
type RenameWorktreeBranchRequest =
  components["schemas"]["RenameWorktreeBranchRequest"];
type CreateTabRequest = components["schemas"]["CreateTabRequest"];
type UpdateTabRequest = components["schemas"]["UpdateTabRequest"];
type ReorderTabsRequest = components["schemas"]["ReorderTabsRequest"];
type UpdateWorktreeTabLayoutRequest =
  components["schemas"]["UpdateWorktreeTabLayoutRequest"];
export type UpdateWorktreeRestoreStateRequest = {
  activeTabId?: string | null;
  focusedPaneId?: string | null;
  paneMru?: string[] | null;
  tabMruByPane?: Record<string, string[]> | null;
};
type ApiErrorResponse = components["schemas"]["ApiErrorResponse"];
type WriteWorktreeFileContentRequest =
  components["schemas"]["WriteWorktreeFileContentRequest"];
type WriteWorktreeFileContentResponse =
  components["schemas"]["WriteWorktreeFileContentResponse"];

function throwStatusError(status: number, message?: string): never {
  throw new ApiStatusError(status, message);
}

async function readApiErrorMessage(res: Response): Promise<string | null> {
  if (typeof res.json !== "function") {
    return null;
  }

  try {
    const payload = (await res.json()) as Partial<ApiErrorResponse>;
    return typeof payload.message === "string" ? payload.message : null;
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function addProject(path: string): Promise<Project> {
  const payload: AddProjectRequest = { path };
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function updateProject(
  id: string,
  updates: UpdateProjectRequest,
): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function reorderProjects(
  projectIds: string[],
): Promise<Project[]> {
  const payload: ReorderProjectsRequest = { project_ids: projectIds };
  const res = await fetch(`${BASE}/projects/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export type DeleteProjectOptions = {
  deleteManagedWorktrees?: boolean;
  force?: boolean;
};

export async function deleteProject(
  id: string,
  options: DeleteProjectOptions = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (options.deleteManagedWorktrees) {
    params.set("delete_managed_worktrees", "true");
  }
  if (options.force) {
    params.set("force", "true");
  }
  const qs = params.toString();
  const res = await fetch(`${BASE}/projects/${id}${qs ? `?${qs}` : ""}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throwStatusError(res.status);
  }
}

export async function listProjectWorktrees(
  projectId: string,
): Promise<ListWorktreesResponse> {
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export type WorktreeStartPoint = StartPoint;
export type WorktreeGitStatus = WorktreeGitStatusResponse;
export type WorktreeFile = WorktreeFileEntry;
export type WorktreeFileType = WorktreeFileKind;
export type WorktreeGitFileChange = GitFileChange;
export type WorktreeGitCommitSummary = GitCommitSummary;
export type WorktreeGitCommitPerson = GitCommitPerson;
export type WorktreeGitCommitDetails = GitCommitDetailsResponse;
export type WorktreeFileContent = WorktreeFileContentResponse;
export type SaveWorktreeFileContentResponse = WriteWorktreeFileContentResponse;
export type WorktreeGitDiff = WorktreeGitDiffResponse;
export type ChatConversationSummary =
  components["schemas"]["ChatConversationSummary"];
export type ChatConversationDetail =
  components["schemas"]["ChatConversationDetail"];
export type ChatRuntimeStatus = components["schemas"]["ChatRuntimeStatus"];
type SendChatMessageRequest = components["schemas"]["SendChatMessageRequest"];

export async function listProjectWorktreeStartPoints(
  projectId: string,
): Promise<ListWorktreeStartPointsResponse> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/start-points`,
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function createProjectWorktree(
  projectId: string,
  branch: string,
  startPoint?: string,
  sourceRef?: string,
): Promise<Worktree> {
  const body: CreateWorktreeRequest = { branch };
  if (startPoint) {
    body.start_point = startPoint;
  }
  if (sourceRef) {
    body.source_ref = sourceRef;
  }
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export type ImportableWorktree =
  ListImportableWorktreesResponse["importable_worktrees"][number];

export async function listImportableWorktrees(
  projectId: string,
): Promise<ListImportableWorktreesResponse> {
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees/importable`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function importProjectWorktree(
  projectId: string,
  path: string,
): Promise<Worktree> {
  const body: ImportWorktreeRequest = { path };
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function updateProjectWorktree(
  projectId: string,
  worktreeId: string,
  updates: UpdateWorktreeRequest,
): Promise<Worktree> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function renameWorktreeBranch(
  projectId: string,
  worktreeId: string,
  newBranch: string,
): Promise<Worktree> {
  const body: RenameWorktreeBranchRequest = {
    new_branch: newBranch,
  };
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/git/rename-branch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getProjectWorktreeGitStatus(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeGitStatusResponse> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/git-status`,
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getProjectWorktreeCommitDetails(
  projectId: string,
  worktreeId: string,
  commitId: string,
): Promise<GitCommitDetailsResponse> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/git/commits/${commitId}`,
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error("Commit not found");
    throw new Error(`${res.status}`);
  }
  return res.json();
}

async function postWorktreeGitPathAction(
  projectId: string,
  worktreeId: string,
  action: "stage" | "unstage" | "discard",
  path: string,
  originalPath?: string,
): Promise<void> {
  const payload: WorktreeGitPathActionRequest = { path };
  if (originalPath) {
    payload.original_path = originalPath;
  }
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/git/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    if (res.status === 400) throw new Error("Invalid path");
    if (res.status === 403) throw new Error("Permission denied");
    if (res.status === 404) throw new Error("Path not found");
    throw new Error(`${res.status}`);
  }
}

export async function stageProjectWorktreePath(
  projectId: string,
  worktreeId: string,
  path: string,
  originalPath?: string,
): Promise<void> {
  await postWorktreeGitPathAction(
    projectId,
    worktreeId,
    "stage",
    path,
    originalPath,
  );
}

export async function unstageProjectWorktreePath(
  projectId: string,
  worktreeId: string,
  path: string,
  originalPath?: string,
): Promise<void> {
  await postWorktreeGitPathAction(
    projectId,
    worktreeId,
    "unstage",
    path,
    originalPath,
  );
}

export async function discardProjectWorktreePath(
  projectId: string,
  worktreeId: string,
  path: string,
): Promise<void> {
  await postWorktreeGitPathAction(projectId, worktreeId, "discard", path);
}

export async function listProjectWorktreeFiles(
  projectId: string,
  worktreeId: string,
  path = "",
): Promise<ListWorktreeFilesResponse> {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }

  const qs = params.toString();
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/files${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) {
    if (res.status === 400) throw new Error("Invalid path");
    if (res.status === 403) throw new Error("Permission denied");
    if (res.status === 404) {
      throwStatusError(404, "Directory not found");
    }
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function renameProjectWorktreeFile(
  projectId: string,
  worktreeId: string,
  path: string,
  newName: string,
): Promise<RenameWorktreeFileResponse> {
  const payload: RenameWorktreeFileRequest = {
    path,
    new_name: newName,
  };
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/files/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    if (res.status === 400) throw new Error("Invalid name");
    if (res.status === 403) throw new Error("Permission denied");
    if (res.status === 404) throw new Error("Path not found");
    if (res.status === 409) throw new Error("A file or folder already exists");
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function getProjectWorktreeFileContent(
  projectId: string,
  worktreeId: string,
  path: string,
): Promise<WorktreeFileContentResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/files/content?${params.toString()}`,
  );
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    if (res.status === 400) throw new Error(message ?? "Invalid path");
    if (res.status === 403) throw new Error(message ?? "Permission denied");
    if (res.status === 404) throw new Error(message ?? "File not found");
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function saveProjectWorktreeFileContent(
  projectId: string,
  worktreeId: string,
  path: string,
  content: string,
  expectedVersionToken: string,
): Promise<WriteWorktreeFileContentResponse> {
  const payload: WriteWorktreeFileContentRequest = {
    path,
    content,
    expected_version_token: expectedVersionToken,
  };
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/files/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    if (res.status === 400) throw new Error(message ?? "Unsupported file");
    if (res.status === 403) throw new Error(message ?? "Permission denied");
    if (res.status === 404) throw new Error(message ?? "File not found");
    if (res.status === 409) {
      throwStatusError(409, message ?? "File changed on disk");
    }
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function getProjectWorktreeGitDiff(
  projectId: string,
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
  originalPath?: string,
  commitId?: string,
): Promise<WorktreeGitDiffResponse> {
  const params = new URLSearchParams({
    path,
    scope,
  });
  if (originalPath) {
    params.set("original_path", originalPath);
  }
  if (commitId) {
    params.set("commit_id", commitId);
  }
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/git/diff?${params.toString()}`,
  );
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    if (res.status === 400) throw new Error(message ?? "Invalid path");
    if (res.status === 403) throw new Error(message ?? "Permission denied");
    if (res.status === 404) throw new Error(message ?? "Diff not found");
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function reorderProjectWorktrees(
  projectId: string,
  worktreeIds: string[],
): Promise<Worktree[]> {
  const payload: ReorderWorktreesRequest = { worktree_ids: worktreeIds };
  const res = await fetch(`${BASE}/projects/${projectId}/worktrees/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function deleteProjectWorktree(
  projectId: string,
  worktreeId: string,
  force = false,
  untrackOnly = false,
): Promise<void> {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (untrackOnly) params.set("untrack_only", "true");
  const qs = params.toString();
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}${qs ? `?${qs}` : ""}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok && res.status !== 404) throwStatusError(res.status);
}

export async function listFiles(
  path?: string,
  showHidden = false,
): Promise<ListFilesResponse> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("show_hidden", "true");

  const res = await fetch(`${BASE}/files?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error("Directory not found");
    if (res.status === 403) throw new Error("Permission denied");
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function listTabs(): Promise<Tab[]> {
  const res = await fetch(`${BASE}/tabs`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function createTab(request: CreateTabRequest): Promise<Tab> {
  const res = await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function createTerminalTab(
  worktreeId: string,
  paneId?: string,
): Promise<Tab> {
  return createTab({
    type: "terminal",
    worktree_id: worktreeId,
    pane_id: paneId,
  });
}

export async function deleteTab(id: string): Promise<void> {
  const res = await fetch(`${BASE}/tabs/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
}

export async function updateTab(
  id: string,
  updates: UpdateTabRequest,
): Promise<Tab> {
  const res = await fetch(`${BASE}/tabs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function listProjectWorktreeChats(
  projectId: string,
  worktreeId: string,
  sessionId = "default",
): Promise<ChatConversationSummary[]> {
  const params = new URLSearchParams({ session_id: sessionId });
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/chats?${params.toString()}`,
  );
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function getChat(
  conversationId: string,
): Promise<ChatConversationDetail> {
  const res = await fetch(`${BASE}/chats/${conversationId}`);
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function sendChatMessage(
  conversationId: string,
  text: string,
): Promise<void> {
  const payload: SendChatMessageRequest = { text };
  const res = await fetch(`${BASE}/chats/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
}

export async function interruptChat(conversationId: string): Promise<void> {
  const res = await fetch(`${BASE}/chats/${conversationId}/interrupt`, {
    method: "POST",
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
}

export async function reorderTabs(
  worktreeId: string,
  paneId: string,
  tabIds: string[],
): Promise<Tab[]> {
  const payload: ReorderTabsRequest = {
    worktree_id: worktreeId,
    pane_id: paneId,
    tab_ids: tabIds,
  };
  const res = await fetch(`${BASE}/tabs/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function updateWorktreeTabLayout(
  projectId: string,
  worktreeId: string,
  layout: {
    rootId: string;
    nodes: WorktreePaneNode[];
    panes: WorktreePaneTabs[];
  },
): Promise<WorktreeTabLayoutState> {
  const payload: UpdateWorktreeTabLayoutRequest = {
    rootId: layout.rootId,
    nodes: layout.nodes,
    panes: layout.panes,
  };
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/tab-layout`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function updateWorktreeRestoreState(
  projectId: string,
  worktreeId: string,
  restoreState: UpdateWorktreeRestoreStateRequest,
): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}/restore-state`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeTabId: restoreState.activeTabId ?? null,
        focusedPaneId: restoreState.focusedPaneId ?? null,
        paneMru: restoreState.paneMru ?? [],
        tabMruByPane: restoreState.tabMruByPane ?? {},
      }),
    },
  );
  if (!res.ok && res.status !== 404) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
}

export function terminalWsUrl(tabId: string): string {
  const base = terminalWsUrlBase();
  if (base) {
    const url = new URL(base);
    url.searchParams.set("tab_id", tabId);
    return url.toString();
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/terminal/ws?tab_id=${encodeURIComponent(tabId)}`;
}

// --- Settings ---

export async function getSettings(): Promise<SettingsState> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export function resetApiStateForTests(): void {
  // No shared API state to reset right now.
}

export async function patchSettings(
  partial: SettingsPatch,
): Promise<SettingsState> {
  const res = await fetch(`${BASE}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function replaceSettings(
  settings: Settings,
): Promise<SettingsState> {
  const res = await fetch(`${BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

// --- Keybindings ---

export async function getKeybindings(): Promise<KeybindingsState> {
  const res = await fetch(`${BASE}/keybindings`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function replaceKeybindings(
  keybindings: KeybindingEntry[],
): Promise<KeybindingsState> {
  const res = await fetch(`${BASE}/keybindings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keybindings),
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

// --- Editor Themes ---

export type VscodeTokenColorSettings = {
  foreground?: string;
  fontStyle?: string;
  background?: string;
};

export type VscodeTokenColor = {
  name?: string;
  scope?: string | string[];
  settings: VscodeTokenColorSettings;
};

export type VscodeThemeJson = {
  name: string;
  type?: string;
  colors: Record<string, string>;
  tokenColors: VscodeTokenColor[];
};

export type EditorThemeEntry = {
  id: string;
  name: string;
  type: string;
  builtin: boolean;
};

export async function listEditorThemes(): Promise<EditorThemeEntry[]> {
  const res = await fetch(`${BASE}/editor-themes`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function getEditorTheme(id: string): Promise<VscodeThemeJson> {
  const res = await fetch(`${BASE}/editor-themes/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function uploadEditorTheme(
  rawText: string,
): Promise<EditorThemeEntry> {
  const res = await fetch(`${BASE}/editor-themes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawText,
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function deleteEditorTheme(id: string): Promise<void> {
  const res = await fetch(`${BASE}/editor-themes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
}

// --- Extension Theme Discovery ---

export type DiscoveredTheme = {
  label: string;
  type: string;
  sourcePath: string;
  installedId: string | null;
  differs: boolean;
};

export type DiscoveredExtension = {
  extensionId: string;
  displayName: string;
  version: string;
  sourceEditor: string;
  themes: DiscoveredTheme[];
};

export type ImportThemeRequest = {
  sourceEditor: string;
  sourcePath: string;
  label: string;
  type: string;
  overwriteId?: string;
};

export type VscodeLatestCheck = components["schemas"]["VscodeLatestCheck"];
export type VscodeInstallPhase = components["schemas"]["VscodeInstallPhase"];
export type VscodeInstallProgress =
  components["schemas"]["VscodeInstallProgress"];
export type VscodeProcessStatus = components["schemas"]["VscodeProcessStatus"];
export type VscodeRuntimeStatus = components["schemas"]["VscodeRuntimeStatus"];
export type VscodeStatus = components["schemas"]["VscodeStatus"];
export type VscodeConnectionInfo =
  components["schemas"]["VscodeConnectionInfo"];
type InstallVscodeRequest = components["schemas"]["InstallVscodeRequest"];

export async function discoverExtensionThemes(): Promise<
  DiscoveredExtension[]
> {
  const res = await fetch(`${BASE}/editor-themes/discover`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${BASE}/system`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getVscodeStatus(): Promise<VscodeStatus> {
  const res = await fetch(`${BASE}/vscode`);
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}

export async function checkVscodeUpdate(): Promise<VscodeStatus> {
  const res = await fetch(`${BASE}/vscode/check-update`, {
    method: "POST",
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function installVscode(
  version?: string,
  force = false,
): Promise<VscodeStatus> {
  const payload: InstallVscodeRequest = {};
  if (version) {
    payload.version = version;
  }
  if (force) {
    payload.force = force;
  }
  const res = await fetch(`${BASE}/vscode/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function startVscode(): Promise<VscodeStatus> {
  const res = await fetch(`${BASE}/vscode/start`, {
    method: "POST",
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function stopVscode(): Promise<VscodeStatus> {
  const res = await fetch(`${BASE}/vscode/stop`, {
    method: "POST",
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function restartVscode(): Promise<VscodeStatus> {
  const res = await fetch(`${BASE}/vscode/restart`, {
    method: "POST",
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throwStatusError(res.status, message ?? undefined);
  }
  return res.json();
}

export async function importExtensionTheme(
  req: ImportThemeRequest,
): Promise<EditorThemeEntry> {
  const res = await fetch(`${BASE}/editor-themes/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throwStatusError(res.status);
  }
  return res.json();
}
