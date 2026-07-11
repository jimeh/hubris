import type { components } from "@/lib/contracts/rest.generated";
import type {
  Tab,
  WorktreePaneNode,
  WorktreePaneTabs,
  WorktreeTabLayoutState,
} from "@/lib/types";
import { ApiStatusError, requestJson, requestVoid } from "./client";

type CreateTabRequest = components["schemas"]["CreateTabRequest"];
type UpdateTabRequest = components["schemas"]["UpdateTabRequest"];

export type UpdateWorktreeRestoreStateRequest = {
  activeTabId?: string | null;
  focusedPaneId?: string | null;
  paneMru?: string[] | null;
  tabMruByPane?: Record<string, string[]> | null;
};

export async function listTabs(): Promise<Tab[]> {
  return requestJson("GET", "/api/tabs", {});
}

export async function createTab(request: CreateTabRequest): Promise<Tab> {
  return requestJson("POST", "/api/tabs", { body: request });
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
  try {
    await requestVoid("DELETE", "/api/tabs/{id}", { path: { id } });
  } catch (error) {
    if (!(error instanceof ApiStatusError && error.status === 404)) throw error;
  }
}

export async function updateTab(
  id: string,
  updates: UpdateTabRequest,
): Promise<Tab> {
  return requestJson("PATCH", "/api/tabs/{id}", {
    path: { id },
    body: updates,
  });
}

export async function reorderTabs(
  worktreeId: string,
  paneId: string,
  tabIds: string[],
): Promise<Tab[]> {
  return requestJson("PUT", "/api/tabs/reorder", {
    body: {
      worktree_id: worktreeId,
      pane_id: paneId,
      tab_ids: tabIds,
    },
  });
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
  return requestJson(
    "PUT",
    "/api/projects/{id}/worktrees/{worktree_id}/tab-layout",
    {
      path: { id: projectId, worktree_id: worktreeId },
      body: {
        rootId: layout.rootId,
        nodes: layout.nodes,
        panes: layout.panes,
      },
    },
  );
}

export async function updateWorktreeRestoreState(
  projectId: string,
  worktreeId: string,
  restoreState: UpdateWorktreeRestoreStateRequest,
): Promise<void> {
  try {
    await requestVoid(
      "PUT",
      "/api/projects/{id}/worktrees/{worktree_id}/restore-state",
      {
        path: { id: projectId, worktree_id: worktreeId },
        body: {
          activeTabId: restoreState.activeTabId ?? null,
          focusedPaneId: restoreState.focusedPaneId ?? null,
          paneMru: restoreState.paneMru ?? [],
          tabMruByPane: restoreState.tabMruByPane ?? {},
        },
      },
    );
  } catch (error) {
    if (!(error instanceof ApiStatusError && error.status === 404)) throw error;
  }
}
