import type { ListFilesResponse, Project, Tab, Worktree } from "./types";
import type { components } from "@/lib/contracts/rest.generated";
import type {
  AppearanceSettings,
  TerminalSettings,
  WorktreeSettings,
} from "./theme/types";

const BASE = "/api";

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
type GitFileChange = components["schemas"]["GitFileChange"];
type GitCommitSummary = components["schemas"]["GitCommitSummary"];
type ReorderWorktreesRequest = components["schemas"]["ReorderWorktreesRequest"];
type CreateTabRequest = components["schemas"]["CreateTabRequest"];
type UpdateTabRequest = components["schemas"]["UpdateTabRequest"];
type ReorderTabsRequest = components["schemas"]["ReorderTabsRequest"];

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
export type WorktreeGitFileChange = GitFileChange;
export type WorktreeGitCommitSummary = GitCommitSummary;

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

export async function getSettings(): Promise<{
  appearance?: AppearanceSettings;
  terminal?: TerminalSettings;
  worktree?: WorktreeSettings;
}> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

let settingsSaveQueue = Promise.resolve();

export function resetApiStateForTests(): void {
  settingsSaveQueue = Promise.resolve();
}

export async function saveSettings(partial: {
  appearance?: AppearanceSettings;
  terminal?: TerminalSettings;
  worktree?: WorktreeSettings;
}): Promise<void> {
  const runSave = async (): Promise<void> => {
    // Read-modify-write to avoid clobbering sibling sections.
    // Serialize calls so concurrent saves do not race and overwrite each other.
    const current = await getSettings();
    const merged = { ...current, ...partial };

    const res = await fetch(`${BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged),
    });
    if (!res.ok) throw new Error(`${res.status}`);

    // Cache in localStorage only after server confirms —
    // avoids desync if the save fails.
    if (partial.appearance) {
      localStorage.setItem(
        "hubris-appearance",
        JSON.stringify(partial.appearance),
      );
    }
    if (partial.terminal) {
      localStorage.setItem("hubris-terminal", JSON.stringify(partial.terminal));
    }
  };

  const queuedSave = settingsSaveQueue.then(runSave, runSave);
  settingsSaveQueue = queuedSave.catch(() => {});
  return queuedSave;
}
