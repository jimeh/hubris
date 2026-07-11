import type { components } from "@/lib/contracts/rest.generated";
import type {
  GitDiffScope,
  ListWorktreeFilesResponse,
  RenameWorktreeFileResponse,
  Worktree,
  WorktreeFileContentResponse,
  WorktreeGitDiffResponse,
} from "@/lib/types";
import { ApiStatusError, requestJson, requestVoid } from "./client";

type ListWorktreesResponse = components["schemas"]["ListWorktreesResponse"];
type ListWorktreeStartPointsResponse =
  components["schemas"]["ListWorktreeStartPointsResponse"];
type WorktreeGitStatusResponse =
  components["schemas"]["WorktreeGitStatusResponse"];
type GitCommitDetailsResponse =
  components["schemas"]["GitCommitDetailsResponse"];
type ListImportableWorktreesResponse =
  components["schemas"]["ListImportableWorktreesResponse"];
type UpdateWorktreeRequest = components["schemas"]["UpdateWorktreeRequest"];
type WriteWorktreeFileContentResponse =
  components["schemas"]["WriteWorktreeFileContentResponse"];

export type WorktreeStartPoint = components["schemas"]["StartPoint"];
export type WorktreeGitStatus = WorktreeGitStatusResponse;
export type WorktreeFile = components["schemas"]["WorktreeFileEntry"];
export type WorktreeFileType = components["schemas"]["WorktreeFileKind"];
export type WorktreeGitFileChange = components["schemas"]["GitFileChange"];
export type WorktreeGitCommitSummary =
  components["schemas"]["GitCommitSummary"];
export type WorktreeGitCommitPerson = components["schemas"]["GitCommitPerson"];
export type WorktreeGitCommitDetails = GitCommitDetailsResponse;
export type WorktreeFileContent = WorktreeFileContentResponse;
export type SaveWorktreeFileContentResponse = WriteWorktreeFileContentResponse;
export type WorktreeGitDiff = WorktreeGitDiffResponse;
export type ImportableWorktree =
  ListImportableWorktreesResponse["importable_worktrees"][number];

export async function listProjectWorktrees(
  projectId: string,
): Promise<ListWorktreesResponse> {
  return requestJson("GET", "/api/projects/{id}/worktrees", {
    path: { id: projectId },
  });
}

export async function listProjectWorktreeStartPoints(
  projectId: string,
): Promise<ListWorktreeStartPointsResponse> {
  return requestJson("GET", "/api/projects/{id}/worktrees/start-points", {
    path: { id: projectId },
  });
}

export async function createProjectWorktree(
  projectId: string,
  branch: string,
  startPoint?: string,
  sourceRef?: string,
): Promise<Worktree> {
  return requestJson("POST", "/api/projects/{id}/worktrees", {
    path: { id: projectId },
    body: {
      branch,
      ...(startPoint ? { start_point: startPoint } : {}),
      ...(sourceRef ? { source_ref: sourceRef } : {}),
    },
  });
}

export async function listImportableWorktrees(
  projectId: string,
): Promise<ListImportableWorktreesResponse> {
  return requestJson("GET", "/api/projects/{id}/worktrees/importable", {
    path: { id: projectId },
  });
}

export async function importProjectWorktree(
  projectId: string,
  path: string,
): Promise<Worktree> {
  return requestJson("POST", "/api/projects/{id}/worktrees/import", {
    path: { id: projectId },
    body: { path },
  });
}

export async function updateProjectWorktree(
  projectId: string,
  worktreeId: string,
  updates: UpdateWorktreeRequest,
): Promise<Worktree> {
  return requestJson("PATCH", "/api/projects/{id}/worktrees/{worktree_id}", {
    path: { id: projectId, worktree_id: worktreeId },
    body: updates,
  });
}

export async function renameWorktreeBranch(
  projectId: string,
  worktreeId: string,
  newBranch: string,
): Promise<Worktree> {
  return requestJson(
    "POST",
    "/api/projects/{id}/worktrees/{worktree_id}/git/rename-branch",
    {
      path: { id: projectId, worktree_id: worktreeId },
      body: { new_branch: newBranch },
    },
  );
}

export async function getProjectWorktreeGitStatus(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeGitStatusResponse> {
  return requestJson(
    "GET",
    "/api/projects/{id}/worktrees/{worktree_id}/git-status",
    { path: { id: projectId, worktree_id: worktreeId } },
  );
}

export async function getProjectWorktreeCommitDetails(
  projectId: string,
  worktreeId: string,
  commitId: string,
): Promise<GitCommitDetailsResponse> {
  return requestJson(
    "GET",
    "/api/projects/{id}/worktrees/{worktree_id}/git/commits/{commit_id}",
    {
      path: {
        id: projectId,
        worktree_id: worktreeId,
        commit_id: commitId,
      },
    },
  );
}

async function postWorktreeGitPathAction(
  projectId: string,
  worktreeId: string,
  action: "stage" | "unstage" | "discard",
  path: string,
  originalPath?: string,
): Promise<void> {
  const requestPath = {
    stage: "/api/projects/{id}/worktrees/{worktree_id}/git/stage",
    unstage: "/api/projects/{id}/worktrees/{worktree_id}/git/unstage",
    discard: "/api/projects/{id}/worktrees/{worktree_id}/git/discard",
  } as const;
  await requestVoid("POST", requestPath[action], {
    path: { id: projectId, worktree_id: worktreeId },
    body: {
      path,
      ...(originalPath ? { original_path: originalPath } : {}),
    },
  });
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
  return requestJson(
    "GET",
    "/api/projects/{id}/worktrees/{worktree_id}/files",
    {
      path: { id: projectId, worktree_id: worktreeId },
      ...(path ? { query: { path } } : {}),
    },
  );
}

export async function renameProjectWorktreeFile(
  projectId: string,
  worktreeId: string,
  path: string,
  newName: string,
): Promise<RenameWorktreeFileResponse> {
  return requestJson(
    "POST",
    "/api/projects/{id}/worktrees/{worktree_id}/files/rename",
    {
      path: { id: projectId, worktree_id: worktreeId },
      body: { path, new_name: newName },
    },
  );
}

export async function getProjectWorktreeFileContent(
  projectId: string,
  worktreeId: string,
  path: string,
): Promise<WorktreeFileContentResponse> {
  return requestJson(
    "GET",
    "/api/projects/{id}/worktrees/{worktree_id}/files/content",
    {
      path: { id: projectId, worktree_id: worktreeId },
      query: { path },
    },
  );
}

export async function saveProjectWorktreeFileContent(
  projectId: string,
  worktreeId: string,
  path: string,
  content: string,
  expectedVersionToken: string,
): Promise<WriteWorktreeFileContentResponse> {
  return requestJson(
    "PUT",
    "/api/projects/{id}/worktrees/{worktree_id}/files/content",
    {
      path: { id: projectId, worktree_id: worktreeId },
      body: {
        path,
        content,
        expected_version_token: expectedVersionToken,
      },
    },
  );
}

export async function getProjectWorktreeGitDiff(
  projectId: string,
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
  originalPath?: string,
  commitId?: string,
): Promise<WorktreeGitDiffResponse> {
  return requestJson(
    "GET",
    "/api/projects/{id}/worktrees/{worktree_id}/git/diff",
    {
      path: { id: projectId, worktree_id: worktreeId },
      query: {
        path,
        scope,
        ...(originalPath ? { original_path: originalPath } : {}),
        ...(commitId ? { commit_id: commitId } : {}),
      },
    },
  );
}

export async function reorderProjectWorktrees(
  projectId: string,
  worktreeIds: string[],
): Promise<Worktree[]> {
  return requestJson("PUT", "/api/projects/{id}/worktrees/reorder", {
    path: { id: projectId },
    body: { worktree_ids: worktreeIds },
  });
}

export async function deleteProjectWorktree(
  projectId: string,
  worktreeId: string,
  force = false,
  untrackOnly = false,
): Promise<void> {
  const query = {
    ...(force ? { force: true } : {}),
    ...(untrackOnly ? { untrack_only: true } : {}),
  };
  try {
    await requestVoid("DELETE", "/api/projects/{id}/worktrees/{worktree_id}", {
      path: { id: projectId, worktree_id: worktreeId },
      ...(Object.keys(query).length > 0 ? { query } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiStatusError && error.status === 404)) throw error;
  }
}
