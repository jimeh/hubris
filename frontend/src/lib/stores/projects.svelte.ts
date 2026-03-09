import {
  addProject,
  deleteProject,
  type DeleteProjectOptions,
  reorderProjects,
  updateProject,
} from "$lib/api";
import { getEventClient } from "$lib/events";
import type { Project } from "$lib/types";

const LS_EXPANDED = "hubris-expanded-projects";

function lsGetJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable
  }
}

let projects = $state<Project[]>([]);
let expandedById = $state<Record<string, boolean>>(
  lsGetJson<Record<string, boolean>>(LS_EXPANDED) ?? {},
);
let initialized = false;

function sortedProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function ensureExpandedState(): void {
  for (const project of projects) {
    if (expandedById[project.id] === undefined) {
      expandedById[project.id] = true;
    }
  }
  expandedById = { ...expandedById };
  lsSet(LS_EXPANDED, expandedById);
}

export function getProjectStore() {
  if (!initialized) {
    initialized = true;
    const events = getEventClient();

    events.on("snapshot", (data) => {
      if (data.projects) {
        projects = sortedProjects(data.projects);
        ensureExpandedState();
      }
    });

    events.on("project_added", (project) => {
      if (!projects.find((p) => p.id === project.id)) {
        projects = sortedProjects([...projects, project]);
        ensureExpandedState();
      }
    });

    events.on("project_removed", ({ project_id }) => {
      projects = projects.filter((p) => p.id !== project_id);
      delete expandedById[project_id];
      expandedById = { ...expandedById };
      lsSet(LS_EXPANDED, expandedById);
    });

    events.on("project_updated", (project) => {
      projects = sortedProjects(
        projects.map((p) => (p.id === project.id ? project : p)),
      );
    });

    events.on("projects_reordered", (reordered) => {
      projects = reordered;
      ensureExpandedState();
    });
  }

  async function add(path: string): Promise<Project> {
    const project = await addProject(path);
    if (!projects.find((p) => p.id === project.id)) {
      projects = sortedProjects([...projects, project]);
      ensureExpandedState();
    }
    return project;
  }

  async function remove(
    id: string,
    options: DeleteProjectOptions = {},
  ): Promise<void> {
    await deleteProject(id, options);
  }

  async function reorder(orderedIds: string[]): Promise<void> {
    projects = [...projects]
      .map((project) => {
        const idx = orderedIds.indexOf(project.id);
        return {
          ...project,
          position: idx >= 0 ? idx + 1 : (project.position ?? 0),
        };
      })
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    await reorderProjects(orderedIds);
  }

  async function rename(id: string, name: string): Promise<void> {
    const updated = await updateProject(id, { name });
    projects = sortedProjects(
      projects.map((project) => (project.id === id ? updated : project)),
    );
  }

  function toggleExpanded(projectId: string): void {
    expandedById[projectId] = !isExpanded(projectId);
    expandedById = { ...expandedById };
    lsSet(LS_EXPANDED, expandedById);
  }

  function isExpanded(projectId: string): boolean {
    return expandedById[projectId] ?? true;
  }

  return {
    get projects() {
      return projects;
    },
    add,
    remove,
    reorder,
    rename,
    toggleExpanded,
    isExpanded,
  };
}
