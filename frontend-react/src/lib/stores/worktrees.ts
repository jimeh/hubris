import { create } from "zustand";
import {
  createProjectWorktree,
  deleteProjectWorktree,
  reorderProjectWorktrees,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Worktree } from "@/lib/types";

const LS_SELECTED = "hubris-selected-worktree";

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

function byStableFallback(a: Worktree, b: Worktree): number {
  const byProjectId = a.project_id.localeCompare(b.project_id);
  if (byProjectId !== 0) return byProjectId;

  const byPos = a.position - b.position;
  if (byPos !== 0) return byPos;

  return a.id.localeCompare(b.id);
}

interface WorktreeState {
  worktreesByProject: Record<string, Worktree[]>;
  projectErrors: Record<string, string>;
  selectedWorktreeId: string | null;

  worktreesForProject: (projectId: string) => Worktree[];
  selectedWorktree: () => Worktree | null;
  projectError: (projectId: string) => string | null;
  select: (worktreeId: string) => void;
  create: (
    projectId: string,
    branch: string,
    startPoint?: string,
  ) => Promise<Worktree>;
  remove: (
    projectId: string,
    worktreeId: string,
    force?: boolean,
  ) => Promise<void>;
  reorder: (projectId: string, orderedIds: string[]) => Promise<void>;
}

function allWorktrees(byProject: Record<string, Worktree[]>): Worktree[] {
  return Object.values(byProject).flat();
}

function resolveSelected(
  id: string | null,
  byProject: Record<string, Worktree[]>,
): Worktree | null {
  if (!id) return null;
  return allWorktrees(byProject).find((wt) => wt.id === id) ?? null;
}

function ensureSelection(
  set: (partial: Partial<WorktreeState>) => void,
  get: () => WorktreeState,
): void {
  const { selectedWorktreeId, worktreesByProject } = get();
  const selected = resolveSelected(selectedWorktreeId, worktreesByProject);
  if (selected) return;

  const first = allWorktrees(worktreesByProject).sort(byStableFallback).at(0);
  const nextId = first?.id ?? null;
  lsSet(LS_SELECTED, nextId);
  set({ selectedWorktreeId: nextId });
}

function upsertWorktree(
  worktreesByProject: Record<string, Worktree[]>,
  worktree: Worktree,
): Record<string, Worktree[]> {
  const list = worktreesByProject[worktree.project_id] ?? [];
  const next = { ...worktreesByProject };
  if (list.find((wt) => wt.id === worktree.id)) {
    next[worktree.project_id] = byPosition(
      list.map((wt) => (wt.id === worktree.id ? worktree : wt)),
    );
  } else {
    next[worktree.project_id] = byPosition([...list, worktree]);
  }
  return next;
}

export const useWorktreeStore = create<WorktreeState>((set, get) => {
  const events = getEventClient();

  events.on("snapshot", (data) => {
    if (data.worktrees) {
      const next: Record<string, Worktree[]> = {};
      for (const [projectId, worktrees] of Object.entries(data.worktrees)) {
        next[projectId] = byPosition(worktrees ?? []);
      }
      const projectErrors = Object.fromEntries(
        Object.entries(data.project_errors ?? {}).filter(
          ([, err]) => err !== undefined,
        ),
      ) as Record<string, string>;
      set({ worktreesByProject: next, projectErrors });
    }
    ensureSelection(set, get);
  });

  events.on("project_removed", ({ project_id }) => {
    const { worktreesByProject, projectErrors } = get();
    const nextWt = { ...worktreesByProject };
    delete nextWt[project_id];
    const nextErr = { ...projectErrors };
    delete nextErr[project_id];
    set({
      worktreesByProject: nextWt,
      projectErrors: nextErr,
    });
    ensureSelection(set, get);
  });

  events.on("worktree_created", (worktree) => {
    const { worktreesByProject } = get();
    set({
      worktreesByProject: upsertWorktree(worktreesByProject, worktree),
    });
  });

  events.on("worktree_deleted", ({ project_id, worktree_id }) => {
    const { worktreesByProject } = get();
    const next = { ...worktreesByProject };
    next[project_id] = (next[project_id] ?? []).filter(
      (wt) => wt.id !== worktree_id,
    );
    set({ worktreesByProject: next });
    ensureSelection(set, get);
  });

  events.on("worktrees_reordered", ({ project_id, worktrees }) => {
    const { worktreesByProject } = get();
    set({
      worktreesByProject: {
        ...worktreesByProject,
        [project_id]: byPosition(worktrees),
      },
    });
  });

  events.on(
    "project_worktrees_updated",
    ({ project_id, worktrees, git_error }) => {
      const { worktreesByProject, projectErrors } = get();
      const nextErr = { ...projectErrors };
      if (git_error) {
        nextErr[project_id] = git_error;
      } else {
        delete nextErr[project_id];
      }
      set({
        worktreesByProject: {
          ...worktreesByProject,
          [project_id]: byPosition(worktrees),
        },
        projectErrors: nextErr,
      });
      ensureSelection(set, get);
    },
  );

  return {
    worktreesByProject: {},
    projectErrors: {},
    selectedWorktreeId: lsGet(LS_SELECTED),

    worktreesForProject(projectId: string): Worktree[] {
      return get().worktreesByProject[projectId] ?? [];
    },

    selectedWorktree(): Worktree | null {
      const { selectedWorktreeId, worktreesByProject } = get();
      return resolveSelected(selectedWorktreeId, worktreesByProject);
    },

    projectError(projectId: string): string | null {
      return get().projectErrors[projectId] ?? null;
    },

    select(worktreeId: string): void {
      lsSet(LS_SELECTED, worktreeId);
      set({ selectedWorktreeId: worktreeId });
    },

    async create(
      projectId: string,
      branch: string,
      startPoint?: string,
    ): Promise<Worktree> {
      const worktree = await createProjectWorktree(
        projectId,
        branch,
        startPoint,
      );

      const { worktreesByProject } = get();
      const list = worktreesByProject[projectId] ?? [];
      const local = list.find((wt) => wt.is_local);
      const nonLocal = list.filter(
        (wt) => !wt.is_local && wt.id !== worktree.id,
      );
      const next = [
        ...(local ? [{ ...local, position: 1 }] : []),
        { ...worktree, position: 2 },
        ...nonLocal,
      ].map((wt, idx) => ({ ...wt, position: idx + 1 }));

      set({
        worktreesByProject: {
          ...worktreesByProject,
          [projectId]: next,
        },
      });
      get().select(worktree.id);
      return worktree;
    },

    async remove(
      projectId: string,
      worktreeId: string,
      force = false,
    ): Promise<void> {
      const { worktreesByProject } = get();
      const before = worktreesByProject[projectId] ?? [];
      const after = before
        .filter((wt) => wt.id !== worktreeId)
        .map((wt, idx) => ({ ...wt, position: idx + 1 }));
      set({
        worktreesByProject: {
          ...worktreesByProject,
          [projectId]: after,
        },
      });
      ensureSelection(set, get);

      try {
        await deleteProjectWorktree(projectId, worktreeId, force);
      } catch (err) {
        set({
          worktreesByProject: {
            ...get().worktreesByProject,
            [projectId]: before,
          },
        });
        ensureSelection(set, get);
        throw err;
      }
    },

    async reorder(projectId: string, orderedIds: string[]): Promise<void> {
      const { worktreesByProject } = get();
      const current = worktreesByProject[projectId] ?? [];
      const local = current.find((wt) => wt.is_local);
      const nonLocalById = Object.fromEntries(
        current.filter((wt) => !wt.is_local).map((wt) => [wt.id, wt]),
      ) as Record<string, Worktree>;

      const orderedNonLocal: Worktree[] = [];
      for (const id of orderedIds) {
        const wt = nonLocalById[id];
        if (wt) orderedNonLocal.push(wt);
      }

      const next = [
        ...(local ? [{ ...local, position: 1 }] : []),
        ...orderedNonLocal,
      ].map((wt, idx) => ({ ...wt, position: idx + 1 }));

      set({
        worktreesByProject: {
          ...worktreesByProject,
          [projectId]: next,
        },
      });

      await reorderProjectWorktrees(projectId, orderedIds);
    },
  };
});
