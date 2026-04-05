import { create } from "zustand";
import {
  addProject,
  deleteProject,
  type DeleteProjectOptions,
  reorderProjects,
  updateProject,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Project } from "@/lib/types";

const LS_EXPANDED = "hubris-expanded-projects";

type ProjectsState = {
  projects: Project[];
  homeDir: string | null;
  expandedById: Record<string, boolean>;
  add: (path: string) => Promise<Project>;
  remove: (id: string, options?: DeleteProjectOptions) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  toggleExpanded: (projectId: string) => void;
};

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

function sortedProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function ensureExpandedState(
  projects: Project[],
  expandedById: Record<string, boolean>,
): Record<string, boolean> {
  let changed = false;
  const next = { ...expandedById };
  for (const project of projects) {
    if (next[project.id] === undefined) {
      next[project.id] = true;
      changed = true;
    }
  }
  if (changed) {
    lsSet(LS_EXPANDED, next);
  }
  return changed ? next : expandedById;
}

function initialExpandedState(): Record<string, boolean> {
  return lsGetJson<Record<string, boolean>>(LS_EXPANDED) ?? {};
}

export const useProjectStore = create<ProjectsState>((set) => ({
  projects: [],
  homeDir: null,
  expandedById: initialExpandedState(),
  async add(path) {
    const project = await addProject(path);
    set((state) => {
      if (state.projects.some((candidate) => candidate.id === project.id)) {
        return state;
      }
      const projects = sortedProjects([...state.projects, project]);
      return {
        projects,
        expandedById: ensureExpandedState(projects, state.expandedById),
      };
    });
    return project;
  },
  async remove(id, options = {}) {
    await deleteProject(id, options);
  },
  async reorder(orderedIds) {
    set((state) => ({
      projects: [...state.projects]
        .map((project) => {
          const idx = orderedIds.indexOf(project.id);
          return {
            ...project,
            position: idx >= 0 ? idx + 1 : (project.position ?? 0),
          };
        })
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    }));

    await reorderProjects(orderedIds);
  },
  async rename(id, name) {
    const updated = await updateProject(id, { name });
    set((state) => ({
      projects: sortedProjects(
        state.projects.map((project) =>
          project.id === id ? updated : project,
        ),
      ),
    }));
  },
  toggleExpanded(projectId) {
    set((state) => {
      const expandedById = {
        ...state.expandedById,
        [projectId]: !(state.expandedById[projectId] ?? true),
      };
      lsSet(LS_EXPANDED, expandedById);
      return { expandedById };
    });
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeProjectStore(): void {
  if (initialized) return;
  initialized = true;

  const events = getEventClient();

  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      if (!data.projects) return;
      const projects = sortedProjects(data.projects);
      useProjectStore.setState((state) => ({
        projects,
        homeDir: data.home_dir ?? state.homeDir,
        expandedById: ensureExpandedState(projects, state.expandedById),
      }));
    }),
    events.on("project_added", (project) => {
      useProjectStore.setState((state) => {
        if (state.projects.some((candidate) => candidate.id === project.id)) {
          return state;
        }
        const projects = sortedProjects([...state.projects, project]);
        return {
          projects,
          expandedById: ensureExpandedState(projects, state.expandedById),
        };
      });
    }),
    events.on("project_removed", ({ project_id }) => {
      useProjectStore.setState((state) => {
        const projects = state.projects.filter(
          (project) => project.id !== project_id,
        );
        const expandedById = { ...state.expandedById };
        delete expandedById[project_id];
        lsSet(LS_EXPANDED, expandedById);
        return { projects, expandedById };
      });
    }),
    events.on("project_updated", (project) => {
      useProjectStore.setState((state) => ({
        projects: sortedProjects(
          state.projects.map((candidate) =>
            candidate.id === project.id ? project : candidate,
          ),
        ),
      }));
    }),
    events.on("projects_reordered", (projects) => {
      useProjectStore.setState((state) => ({
        projects,
        expandedById: ensureExpandedState(projects, state.expandedById),
      }));
    }),
  ];
}

export function resetProjectStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useProjectStore.setState({
    projects: [],
    homeDir: null,
    expandedById: initialExpandedState(),
  });
}

export function isProjectExpanded(projectId: string): boolean {
  return useProjectStore.getState().expandedById[projectId] ?? true;
}
