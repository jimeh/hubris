import type {
  ListFilesResponse,
  ListWorktreeFilesResponse,
  Project,
  RenameWorktreeFileResponse,
  Tab,
  Worktree,
} from "./types";
import type { components } from "@/lib/contracts/rest.generated";
import type { Settings, SettingsPatch, SettingsState } from "./theme/types";

const BASE = "/api";

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
type CreateTabRequest = components["schemas"]["CreateTabRequest"];
type UpdateTabRequest = components["schemas"]["UpdateTabRequest"];
type ReorderTabsRequest = components["schemas"]["ReorderTabsRequest"];

function throwStatusError(status: number, message?: string): never {
  throw new ApiStatusError(status, message);
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
    throw new Error(`${res.status}`);
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
): Promise<void> {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  const qs = params.toString();
  const res = await fetch(
    `${BASE}/projects/${projectId}/worktrees/${worktreeId}${qs ? `?${qs}` : ""}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
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

export async function createTab(worktreeId: string): Promise<Tab> {
  const payload: CreateTabRequest = { worktree_id: worktreeId };
  const res = await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
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

export async function reorderTabs(
  worktreeId: string,
  tabIds: string[],
): Promise<Tab[]> {
  const payload: ReorderTabsRequest = {
    worktree_id: worktreeId,
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

export function terminalWsUrl(tabId: string): string {
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
