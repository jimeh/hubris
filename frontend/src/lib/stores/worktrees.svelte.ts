import {
  createProjectWorktree,
  deleteProjectWorktree,
  reorderProjectWorktrees,
} from '$lib/api';
import { getEventClient } from '$lib/events';
import type { Worktree } from '$lib/types';

const LS_SELECTED = 'hubris-selected-worktree';

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

let worktreesByProject = $state<Record<string, Worktree[]>>({});
let projectErrors = $state<Record<string, string>>({});
let selectedWorktreeId = $state<string | null>(lsGet(LS_SELECTED));
let initialized = false;

function allWorktrees(): Worktree[] {
  return Object.values(worktreesByProject).flat();
}

function byStableFallback(a: Worktree, b: Worktree): number {
  const byProjectId = a.project_id.localeCompare(b.project_id);
  if (byProjectId !== 0) return byProjectId;

  const byPosition = a.position - b.position;
  if (byPosition !== 0) return byPosition;

  return a.id.localeCompare(b.id);
}

function resolveSelected(): Worktree | null {
  if (!selectedWorktreeId) return null;
  return allWorktrees().find((wt) => wt.id === selectedWorktreeId) ?? null;
}

function ensureSelection(): void {
  const selected = resolveSelected();
  if (selected) return;

  const first = allWorktrees().sort(byStableFallback).at(0);
  selectedWorktreeId = first?.id ?? null;
  lsSet(LS_SELECTED, selectedWorktreeId);
}

function upsertWorktree(worktree: Worktree): void {
  const list = worktreesByProject[worktree.project_id] ?? [];
  if (list.find((wt) => wt.id === worktree.id)) {
    worktreesByProject[worktree.project_id] = byPosition(
      list.map((wt) => (wt.id === worktree.id ? worktree : wt)),
    );
  } else {
    worktreesByProject[worktree.project_id] = byPosition([...list, worktree]);
  }
}

export function getWorktreeStore() {
  if (!initialized) {
    initialized = true;
    const events = getEventClient();

    events.on('snapshot', (data) => {
      if (data.worktrees) {
        const next: Record<string, Worktree[]> = {};
        for (const [projectId, worktrees] of Object.entries(data.worktrees)) {
          next[projectId] = byPosition(worktrees ?? []);
        }
        worktreesByProject = next;
      }
      projectErrors = Object.fromEntries(
        Object.entries(data.project_errors ?? {}).filter(
          ([, err]) => err !== undefined,
        ),
      ) as Record<string, string>;
      ensureSelection();
    });

    events.on('project_removed', ({ project_id }) => {
      delete worktreesByProject[project_id];
      delete projectErrors[project_id];
      worktreesByProject = { ...worktreesByProject };
      projectErrors = { ...projectErrors };
      ensureSelection();
    });

    events.on('worktree_created', (worktree) => {
      upsertWorktree(worktree);
    });

    events.on('worktree_deleted', ({ project_id, worktree_id }) => {
      worktreesByProject[project_id] = (
        worktreesByProject[project_id] ?? []
      ).filter((wt) => wt.id !== worktree_id);
      worktreesByProject = { ...worktreesByProject };
      ensureSelection();
    });

    events.on('worktrees_reordered', ({ project_id, worktrees }) => {
      worktreesByProject[project_id] = byPosition(worktrees);
      worktreesByProject = { ...worktreesByProject };
    });

    events.on(
      'project_worktrees_updated',
      ({ project_id, worktrees, git_error }) => {
        worktreesByProject[project_id] = byPosition(worktrees);
        if (git_error) {
          projectErrors[project_id] = git_error;
        } else {
          delete projectErrors[project_id];
        }
        worktreesByProject = { ...worktreesByProject };
        projectErrors = { ...projectErrors };
        ensureSelection();
      },
    );
  }

  function worktreesForProject(projectId: string): Worktree[] {
    return worktreesByProject[projectId] ?? [];
  }

  function select(worktreeId: string): void {
    selectedWorktreeId = worktreeId;
    lsSet(LS_SELECTED, worktreeId);
  }

  async function create(
    projectId: string,
    branch: string,
    startPoint?: string,
  ): Promise<Worktree> {
    const worktree = await createProjectWorktree(projectId, branch, startPoint);

    const list = worktreesByProject[projectId] ?? [];
    const local = list.find((wt) => wt.is_local);
    const nonLocal = list.filter((wt) => !wt.is_local && wt.id !== worktree.id);
    const next = [
      ...(local ? [{ ...local, position: 1 }] : []),
      { ...worktree, position: 2 },
      ...nonLocal,
    ].map((wt, idx) => ({ ...wt, position: idx + 1 }));

    worktreesByProject[projectId] = next;
    worktreesByProject = { ...worktreesByProject };
    select(worktree.id);
    return worktree;
  }

  async function remove(
    projectId: string,
    worktreeId: string,
    force = false,
  ): Promise<void> {
    const before = worktreesByProject[projectId] ?? [];
    worktreesByProject[projectId] = before
      .filter((wt) => wt.id !== worktreeId)
      .map((wt, idx) => ({ ...wt, position: idx + 1 }));
    worktreesByProject = { ...worktreesByProject };
    ensureSelection();

    try {
      await deleteProjectWorktree(projectId, worktreeId, force);
    } catch (err) {
      worktreesByProject[projectId] = before;
      worktreesByProject = { ...worktreesByProject };
      ensureSelection();
      throw err;
    }
  }

  async function reorder(
    projectId: string,
    orderedIds: string[],
  ): Promise<void> {
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

    worktreesByProject[projectId] = next;
    worktreesByProject = { ...worktreesByProject };

    await reorderProjectWorktrees(projectId, orderedIds);
  }

  return {
    get selectedWorktreeId() {
      return selectedWorktreeId;
    },
    get selectedWorktree() {
      return resolveSelected();
    },
    worktreesForProject,
    select,
    create,
    remove,
    reorder,
    projectError(projectId: string): string | null {
      return projectErrors[projectId] ?? null;
    },
  };
}
