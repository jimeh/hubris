import type { components } from "@/lib/contracts/rest.generated";
import type { Project } from "@/lib/types";
import { ApiStatusError, requestJson, requestVoid } from "./client";

type UpdateProjectRequest = components["schemas"]["UpdateProjectRequest"];

export async function listProjects(): Promise<Project[]> {
  return requestJson("GET", "/api/projects", {});
}

export async function addProject(path: string): Promise<Project> {
  return requestJson("POST", "/api/projects", { body: { path } });
}

export async function updateProject(
  id: string,
  updates: UpdateProjectRequest,
): Promise<Project> {
  return requestJson("PATCH", "/api/projects/{id}", {
    path: { id },
    body: updates,
  });
}

export async function reorderProjects(
  projectIds: string[],
): Promise<Project[]> {
  return requestJson("PUT", "/api/projects/reorder", {
    body: { projectIds: projectIds },
  });
}

export type DeleteProjectOptions = {
  deleteManagedWorktrees?: boolean;
  force?: boolean;
};

export async function deleteProject(
  id: string,
  options: DeleteProjectOptions = {},
): Promise<void> {
  const query = {
    ...(options.deleteManagedWorktrees ? { deleteManagedWorktrees: true } : {}),
    ...(options.force ? { force: true } : {}),
  };
  try {
    await requestVoid("DELETE", "/api/projects/{id}", {
      path: { id },
      ...(Object.keys(query).length > 0 ? { query } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiStatusError && error.status === 404)) throw error;
  }
}
