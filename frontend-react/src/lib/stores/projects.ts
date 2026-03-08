import { create } from "zustand";
import {
  addProject,
  deleteProject,
  reorderProjects,
  updateProject,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Project } from "@/lib/types";

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

function sortedProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

interface ProjectState {
  projects: Project[];
  expandedById: Record<string, boolean>;

  add: (path: string) => Promise<Project>;
  remove: (id: string, force?: boolean) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  toggleExpanded: (projectId: string) => void;
  isExpanded: (projectId: string) => boolean;
}

function ensureExpandedState(
  projects: Project[],
  expandedById: Record<string, boolean>,
): Record<string, boolean> {
  const next = { ...expandedById };
  for (const project of projects) {
    if (next[project.id] === undefined) {
      next[project.id] = true;
    }
  }
  lsSet(LS_EXPANDED, next);
  return next;
}

export const useProjectStore = create<ProjectState>((set, get) => {
  const events = getEventClient();

  events.on("snapshot", (data) => {
    if (data.projects) {
      const projects = sortedProjects(data.projects);
      set({
        projects,
        expandedById: ensureExpandedState(projects, get().expandedById),
      });
    }
  });

  events.on("project_added", (project) => {
    const { projects, expandedById } = get();
    if (!projects.find((p) => p.id === project.id)) {
      const next = sortedProjects([...projects, project]);
      set({
        projects: next,
        expandedById: ensureExpandedState(next, expandedById),
      });
    }
  });

  events.on("project_removed", ({ project_id }) => {
    const { projects, expandedById } = get();
    const next = { ...expandedById };
    delete next[project_id];
    lsSet(LS_EXPANDED, next);
    set({
      projects: projects.filter((p) => p.id !== project_id),
      expandedById: next,
    });
  });

  events.on("project_updated", (project) => {
    const { projects } = get();
    set({
      projects: sortedProjects(
        projects.map((p) => (p.id === project.id ? project : p)),
      ),
    });
  });

  events.on("projects_reordered", (reordered) => {
    const { expandedById } = get();
    set({
      projects: reordered,
      expandedById: ensureExpandedState(reordered, expandedById),
    });
  });

  return {
    projects: [],
    expandedById: lsGetJson<Record<string, boolean>>(LS_EXPANDED) ?? {},

    async add(path: string): Promise<Project> {
      const project = await addProject(path);
      const { projects, expandedById } = get();
      if (!projects.find((p) => p.id === project.id)) {
        const next = sortedProjects([...projects, project]);
        set({
          projects: next,
          expandedById: ensureExpandedState(next, expandedById),
        });
      }
      return project;
    },

    async remove(id: string, force = false): Promise<void> {
      await deleteProject(id, force);
    },

    async reorder(orderedIds: string[]): Promise<void> {
      const { projects } = get();
      const reordered = [...projects]
        .map((project) => {
          const idx = orderedIds.indexOf(project.id);
          return {
            ...project,
            position: idx >= 0 ? idx + 1 : (project.position ?? 0),
          };
        })
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      set({ projects: reordered });
      await reorderProjects(orderedIds);
    },

    async rename(id: string, name: string): Promise<void> {
      const updated = await updateProject(id, { name });
      const { projects } = get();
      set({
        projects: sortedProjects(
          projects.map((p) => (p.id === id ? updated : p)),
        ),
      });
    },

    toggleExpanded(projectId: string): void {
      const { expandedById } = get();
      const next = {
        ...expandedById,
        [projectId]: !(expandedById[projectId] ?? true),
      };
      lsSet(LS_EXPANDED, next);
      set({ expandedById: next });
    },

    isExpanded(projectId: string): boolean {
      return get().expandedById[projectId] ?? true;
    },
  };
});
