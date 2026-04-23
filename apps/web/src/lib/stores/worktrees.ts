import { create } from "zustand";
import {
  createProjectWorktree,
  deleteProjectWorktree,
  importProjectWorktree,
  renameWorktreeBranch,
  reorderProjectWorktrees,
  updateProjectWorktree,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Worktree } from "@/lib/types";

const LS_SELECTED = "hubris-selected-worktree";
const MAX_NAVIGATION_HISTORY = 50;

type WorktreesState = {
  worktreesByProject: Record<string, Worktree[]>;
  projectErrors: Record<string, string>;
  selectedWorktreeId: string | null;
  navigationBackIds: string[];
  navigationForwardIds: string[];
  select: (worktreeId: string) => void;
  navigateBack: () => void;
  navigateForward: () => void;
  create: (
    projectId: string,
    branch: string,
    startPoint?: string,
    sourceRef?: string,
  ) => Promise<Worktree>;
  importWorktree: (projectId: string, path: string) => Promise<Worktree>;
  rename: (
    projectId: string,
    worktreeId: string,
    name: string,
  ) => Promise<void>;
  remove: (
    projectId: string,
    worktreeId: string,
    force?: boolean,
    untrackOnly?: boolean,
  ) => Promise<void>;
  reorder: (projectId: string, orderedIds: string[]) => Promise<void>;
  updateUiMode: (
    projectId: string,
    worktreeId: string,
    uiMode: Worktree["ui_mode"],
  ) => Promise<void>;
  updateSourceRef: (
    projectId: string,
    worktreeId: string,
    sourceRef: string | null,
  ) => Promise<void>;
  renameBranch: (
    projectId: string,
    worktreeId: string,
    newBranch: string,
  ) => Promise<void>;
};

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value == null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // localStorage unavailable
  }
}

function byPosition(list: Worktree[]): Worktree[] {
  return [...list].sort((a, b) => a.position - b.position);
}

function allWorktrees(
  worktreesByProject: Record<string, Worktree[]>,
): Worktree[] {
  return Object.values(worktreesByProject).flat();
}

function byStableFallback(a: Worktree, b: Worktree): number {
  const byProjectId = a.project_id.localeCompare(b.project_id);
  if (byProjectId !== 0) return byProjectId;

  const byPositionValue = a.position - b.position;
  if (byPositionValue !== 0) return byPositionValue;

  return a.id.localeCompare(b.id);
}

function resolveSelected(
  worktreesByProject: Record<string, Worktree[]>,
  selectedWorktreeId: string | null,
): Worktree | null {
  if (!selectedWorktreeId) return null;
  return (
    allWorktrees(worktreesByProject).find(
      (worktree) => worktree.id === selectedWorktreeId,
    ) ?? null
  );
}

function ensureSelection(
  state: Pick<WorktreesState, "worktreesByProject" | "selectedWorktreeId">,
): { selectedWorktreeId: string | null } {
  if (resolveSelected(state.worktreesByProject, state.selectedWorktreeId)) {
    return { selectedWorktreeId: state.selectedWorktreeId };
  }

  const first = allWorktrees(state.worktreesByProject).sort(
    byStableFallback,
  )[0];
  const selectedWorktreeId = first?.id ?? null;
  lsSet(LS_SELECTED, selectedWorktreeId);
  return { selectedWorktreeId };
}

function knownWorktreeIds(
  worktreesByProject: Record<string, Worktree[]>,
): Set<string> {
  return new Set(
    allWorktrees(worktreesByProject).map((worktree) => worktree.id),
  );
}

function pruneNavigationStack(
  ids: string[],
  validIds: Set<string>,
  selectedWorktreeId: string | null,
): string[] {
  const seen = new Set<string>();
  const pruned: string[] = [];
  for (const id of ids) {
    if (id === selectedWorktreeId || !validIds.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    pruned.push(id);
    if (pruned.length >= MAX_NAVIGATION_HISTORY) {
      break;
    }
  }
  return pruned;
}

function pushNavigationStack(
  ids: string[],
  id: string | null,
  validIds: Set<string>,
  selectedWorktreeId: string | null,
): string[] {
  return pruneNavigationStack(
    id ? [id, ...ids] : ids,
    validIds,
    selectedWorktreeId,
  );
}

function selectWorktreePatch(
  state: Pick<
    WorktreesState,
    | "navigationBackIds"
    | "navigationForwardIds"
    | "selectedWorktreeId"
    | "worktreesByProject"
  >,
  worktreeId: string,
) {
  if (worktreeId === state.selectedWorktreeId) {
    return {};
  }

  const validIds = knownWorktreeIds(state.worktreesByProject);
  if (validIds.size > 0 && !validIds.has(worktreeId)) {
    return {};
  }

  lsSet(LS_SELECTED, worktreeId);
  return {
    navigationBackIds: pushNavigationStack(
      state.navigationBackIds,
      state.selectedWorktreeId,
      validIds,
      worktreeId,
    ),
    navigationForwardIds: [],
    selectedWorktreeId: worktreeId,
  };
}

function navigateWorktreePatch(
  state: Pick<
    WorktreesState,
    | "navigationBackIds"
    | "navigationForwardIds"
    | "selectedWorktreeId"
    | "worktreesByProject"
  >,
  direction: "back" | "forward",
) {
  const validIds = knownWorktreeIds(state.worktreesByProject);
  const selectedWorktreeId = state.selectedWorktreeId;
  const backIds = pruneNavigationStack(
    state.navigationBackIds,
    validIds,
    selectedWorktreeId,
  );
  const forwardIds = pruneNavigationStack(
    state.navigationForwardIds,
    validIds,
    selectedWorktreeId,
  );
  const sourceIds = direction === "back" ? backIds : forwardIds;
  const targetId = sourceIds[0];

  if (!targetId) {
    return {
      navigationBackIds: backIds,
      navigationForwardIds: forwardIds,
    };
  }

  lsSet(LS_SELECTED, targetId);
  return direction === "back"
    ? {
        navigationBackIds: sourceIds.slice(1),
        navigationForwardIds: pushNavigationStack(
          forwardIds,
          selectedWorktreeId,
          validIds,
          targetId,
        ),
        selectedWorktreeId: targetId,
      }
    : {
        navigationBackIds: pushNavigationStack(
          backIds,
          selectedWorktreeId,
          validIds,
          targetId,
        ),
        navigationForwardIds: sourceIds.slice(1),
        selectedWorktreeId: targetId,
      };
}

function maintainNavigationState(
  state: Pick<
    WorktreesState,
    | "navigationBackIds"
    | "navigationForwardIds"
    | "selectedWorktreeId"
    | "worktreesByProject"
  >,
) {
  const selection = ensureSelection(state);
  const validIds = knownWorktreeIds(state.worktreesByProject);
  return {
    ...selection,
    navigationBackIds: pruneNavigationStack(
      state.navigationBackIds,
      validIds,
      selection.selectedWorktreeId,
    ),
    navigationForwardIds: pruneNavigationStack(
      state.navigationForwardIds,
      validIds,
      selection.selectedWorktreeId,
    ),
  };
}

function upsertWorktree(
  worktreesByProject: Record<string, Worktree[]>,
  worktree: Worktree,
): Record<string, Worktree[]> {
  const list = worktreesByProject[worktree.project_id] ?? [];
  const nextList = list.some((candidate) => candidate.id === worktree.id)
    ? byPosition(
        list.map((candidate) =>
          candidate.id === worktree.id ? worktree : candidate,
        ),
      )
    : byPosition([...list, worktree]);

  return {
    ...worktreesByProject,
    [worktree.project_id]: nextList,
  };
}

export const useWorktreeStore = create<WorktreesState>((set, get) => ({
  worktreesByProject: {},
  projectErrors: {},
  selectedWorktreeId: lsGet(LS_SELECTED),
  navigationBackIds: [],
  navigationForwardIds: [],
  select(worktreeId) {
    set((state) => selectWorktreePatch(state, worktreeId));
  },
  navigateBack() {
    set((state) => navigateWorktreePatch(state, "back"));
  },
  navigateForward() {
    set((state) => navigateWorktreePatch(state, "forward"));
  },
  async create(projectId, branch, startPoint, sourceRef) {
    const worktree = await createProjectWorktree(
      projectId,
      branch,
      startPoint,
      sourceRef,
    );
    set((state) => {
      const list = state.worktreesByProject[projectId] ?? [];
      const local = list.find((candidate) => candidate.is_local);
      const nonLocal = list.filter(
        (candidate) => !candidate.is_local && candidate.id !== worktree.id,
      );
      const next = [
        ...(local ? [{ ...local, position: 1 }] : []),
        { ...worktree, position: 2 },
        ...nonLocal,
      ].map((candidate, index) => ({
        ...candidate,
        position: index + 1,
      }));

      lsSet(LS_SELECTED, worktree.id);
      return {
        worktreesByProject: {
          ...state.worktreesByProject,
          [projectId]: next,
        },
        ...selectWorktreePatch(
          {
            ...state,
            worktreesByProject: {
              ...state.worktreesByProject,
              [projectId]: next,
            },
          },
          worktree.id,
        ),
      };
    });
    return worktree;
  },
  async importWorktree(projectId, path) {
    const worktree = await importProjectWorktree(projectId, path);
    set((state) => {
      const list = state.worktreesByProject[projectId] ?? [];
      const local = list.find((candidate) => candidate.is_local);
      const nonLocal = list.filter(
        (candidate) => !candidate.is_local && candidate.id !== worktree.id,
      );
      const next = [
        ...(local ? [{ ...local, position: 1 }] : []),
        { ...worktree, position: 2 },
        ...nonLocal,
      ].map((candidate, index) => ({
        ...candidate,
        position: index + 1,
      }));

      lsSet(LS_SELECTED, worktree.id);
      return {
        worktreesByProject: {
          ...state.worktreesByProject,
          [projectId]: next,
        },
        ...selectWorktreePatch(
          {
            ...state,
            worktreesByProject: {
              ...state.worktreesByProject,
              [projectId]: next,
            },
          },
          worktree.id,
        ),
      };
    });
    return worktree;
  },
  async rename(projectId, worktreeId, name) {
    const updated = await updateProjectWorktree(projectId, worktreeId, {
      name,
    });
    set((state) => ({
      worktreesByProject: upsertWorktree(state.worktreesByProject, updated),
    }));
  },
  async remove(projectId, worktreeId, force = false, untrackOnly = false) {
    const before = get().worktreesByProject[projectId] ?? [];
    set((state) => {
      const worktreesByProject = {
        ...state.worktreesByProject,
        [projectId]: before
          .filter((worktree) => worktree.id !== worktreeId)
          .map((worktree, index) => ({ ...worktree, position: index + 1 })),
      };
      return {
        worktreesByProject,
        ...maintainNavigationState({
          ...state,
          worktreesByProject,
          selectedWorktreeId: state.selectedWorktreeId,
        }),
      };
    });

    try {
      await deleteProjectWorktree(projectId, worktreeId, force, untrackOnly);
    } catch (error) {
      set((state) => {
        const worktreesByProject = {
          ...state.worktreesByProject,
          [projectId]: before,
        };
        return {
          worktreesByProject,
          ...maintainNavigationState({
            ...state,
            worktreesByProject,
            selectedWorktreeId: state.selectedWorktreeId,
          }),
        };
      });
      throw error;
    }
  },
  async reorder(projectId, orderedIds) {
    set((state) => {
      const current = state.worktreesByProject[projectId] ?? [];
      const local = current.find((worktree) => worktree.is_local);
      const nonLocal = current.filter((worktree) => !worktree.is_local);
      const nonLocalById = Object.fromEntries(
        nonLocal.map((worktree) => [worktree.id, worktree]),
      ) as Record<string, Worktree>;

      const orderedNonLocal: Worktree[] = [];
      for (const id of orderedIds) {
        const worktree = nonLocalById[id];
        if (worktree) {
          orderedNonLocal.push(worktree);
        }
      }
      const omittedNonLocal = nonLocal.filter(
        (worktree) => !orderedIds.includes(worktree.id),
      );

      return {
        worktreesByProject: {
          ...state.worktreesByProject,
          [projectId]: [
            ...(local ? [{ ...local, position: 1 }] : []),
            ...orderedNonLocal,
            ...omittedNonLocal,
          ].map((worktree, index) => ({
            ...worktree,
            position: index + 1,
          })),
        },
      };
    });

    await reorderProjectWorktrees(projectId, orderedIds);
  },
  async updateUiMode(projectId, worktreeId, uiMode) {
    const before = get().worktreesByProject[projectId] ?? [];
    set((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        [projectId]: (state.worktreesByProject[projectId] ?? []).map(
          (worktree) =>
            worktree.id === worktreeId
              ? { ...worktree, ui_mode: uiMode }
              : worktree,
        ),
      },
    }));

    try {
      const updated = await updateProjectWorktree(projectId, worktreeId, {
        ui_mode: uiMode,
      });
      set((state) => ({
        worktreesByProject: upsertWorktree(state.worktreesByProject, updated),
      }));
    } catch (error) {
      set((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          [projectId]: before,
        },
      }));
      throw error;
    }
  },
  async updateSourceRef(projectId, worktreeId, sourceRef) {
    const before = get().worktreesByProject[projectId] ?? [];
    set((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        [projectId]: (state.worktreesByProject[projectId] ?? []).map(
          (worktree) =>
            worktree.id === worktreeId
              ? { ...worktree, source_ref: sourceRef }
              : worktree,
        ),
      },
    }));

    try {
      const updated = await updateProjectWorktree(projectId, worktreeId, {
        source_ref: sourceRef ?? "",
      });
      set((state) => ({
        worktreesByProject: upsertWorktree(state.worktreesByProject, updated),
      }));
    } catch (error) {
      set((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          [projectId]: before,
        },
      }));
      throw error;
    }
  },
  async renameBranch(projectId, worktreeId, newBranch) {
    const updated = await renameWorktreeBranch(
      projectId,
      worktreeId,
      newBranch,
    );
    set((state) => ({
      worktreesByProject: upsertWorktree(state.worktreesByProject, updated),
    }));
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeWorktreeStore(): void {
  if (initialized) return;
  initialized = true;

  const events = getEventClient();

  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      const worktreesByProject = Object.fromEntries(
        Object.entries(data.worktrees ?? {}).map(([projectId, worktrees]) => [
          projectId,
          byPosition(worktrees ?? []),
        ]),
      );
      const projectErrors = Object.fromEntries(
        Object.entries(data.project_errors ?? {}).filter(([, value]) => value),
      ) as Record<string, string>;

      useWorktreeStore.setState((state) => ({
        worktreesByProject,
        projectErrors,
        ...maintainNavigationState({
          ...state,
          worktreesByProject,
          selectedWorktreeId: state.selectedWorktreeId,
        }),
      }));
    }),
    events.on("project_removed", ({ project_id }) => {
      useWorktreeStore.setState((state) => {
        const worktreesByProject = { ...state.worktreesByProject };
        const projectErrors = { ...state.projectErrors };
        delete worktreesByProject[project_id];
        delete projectErrors[project_id];
        return {
          worktreesByProject,
          projectErrors,
          ...maintainNavigationState({
            ...state,
            worktreesByProject,
            selectedWorktreeId: state.selectedWorktreeId,
          }),
        };
      });
    }),
    events.on("worktree_created", (worktree) => {
      useWorktreeStore.setState((state) => ({
        worktreesByProject: upsertWorktree(state.worktreesByProject, worktree),
      }));
    }),
    events.on("worktree_deleted", ({ project_id, worktree_id }) => {
      useWorktreeStore.setState((state) => {
        const worktreesByProject = {
          ...state.worktreesByProject,
          [project_id]: (state.worktreesByProject[project_id] ?? []).filter(
            (worktree) => worktree.id !== worktree_id,
          ),
        };
        return {
          worktreesByProject,
          ...maintainNavigationState({
            ...state,
            worktreesByProject,
            selectedWorktreeId: state.selectedWorktreeId,
          }),
        };
      });
    }),
    events.on("worktrees_reordered", ({ project_id, worktrees }) => {
      useWorktreeStore.setState((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          [project_id]: byPosition(worktrees),
        },
      }));
    }),
    events.on(
      "project_worktrees_updated",
      ({ project_id, worktrees, git_error }) => {
        useWorktreeStore.setState((state) => {
          const worktreesByProject = {
            ...state.worktreesByProject,
            [project_id]: byPosition(worktrees),
          };
          const projectErrors = { ...state.projectErrors };
          if (git_error) {
            projectErrors[project_id] = git_error;
          } else {
            delete projectErrors[project_id];
          }
          return {
            worktreesByProject,
            projectErrors,
            ...maintainNavigationState({
              ...state,
              worktreesByProject,
              selectedWorktreeId: state.selectedWorktreeId,
            }),
          };
        });
      },
    ),
  ];
}

export function resetWorktreeStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useWorktreeStore.setState({
    worktreesByProject: {},
    projectErrors: {},
    selectedWorktreeId: lsGet(LS_SELECTED),
    navigationBackIds: [],
    navigationForwardIds: [],
  });
}
