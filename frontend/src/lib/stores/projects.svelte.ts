import { addProject, deleteProject, updateProject } from '$lib/api';
import { getEventClient } from '$lib/events';
import type { Project } from '$lib/types';

const LS_SELECTED = 'hubris-selected-project';

let projects = $state<Project[]>([]);
let selected = $state<Project | null>(null);
let initialized = false;

function sortedProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => a.position - b.position);
}

export function getProjectStore() {
  if (!initialized) {
    initialized = true;
    const events = getEventClient();

    events.on<{ projects: Project[] }>('snapshot', (data) => {
      if (data.projects) {
        projects = sortedProjects(data.projects);
        // Validate selected still exists
        if (selected && !projects.find((p) => p.id === selected!.id)) {
          selected = null;
        }
        // Restore previously selected project from localStorage
        if (!selected) {
          try {
            const savedId = localStorage.getItem(LS_SELECTED);
            if (savedId) {
              const match = projects.find((p) => p.id === savedId);
              if (match) selected = match;
            }
          } catch {
            // localStorage unavailable
          }
        }
      }
    });

    events.on<Project>('project_added', (project) => {
      if (!projects.find((p) => p.id === project.id)) {
        projects = sortedProjects([...projects, project]);
      }
    });

    events.on<{ project_id: string }>('project_removed', ({ project_id }) => {
      projects = projects.filter((p) => p.id !== project_id);
      if (selected?.id === project_id) selected = null;
    });

    events.on<Project>('project_updated', (project) => {
      projects = sortedProjects(
        projects.map((p) => (p.id === project.id ? project : p)),
      );
      // Update selected reference if it was the updated project
      if (selected?.id === project.id) {
        selected = project;
      }
    });
  }

  async function add(path: string) {
    const project = await addProject(path);
    // Optimistic: add immediately, SSE deduplicates
    if (!projects.find((p) => p.id === project.id)) {
      projects = sortedProjects([...projects, project]);
    }
    return project;
  }

  async function remove(id: string) {
    // Optimistic remove
    projects = projects.filter((p) => p.id !== id);
    if (selected?.id === id) {
      selected = null;
      try {
        localStorage.removeItem(LS_SELECTED);
      } catch {
        // localStorage unavailable
      }
    }
    try {
      await deleteProject(id);
    } catch {
      // Already gone (other browser removed it)
    }
  }

  async function reorder(id: string, position: number): Promise<void> {
    // Optimistic: update position locally
    projects = sortedProjects(
      projects.map((p) => (p.id === id ? { ...p, position } : p)),
    );
    await updateProject(id, { position });
  }

  function select(project: Project) {
    selected = project;
    try {
      localStorage.setItem(LS_SELECTED, project.id);
    } catch {
      // localStorage full or unavailable
    }
  }

  return {
    get projects() {
      return projects;
    },
    get selected() {
      return selected;
    },
    add,
    remove,
    reorder,
    select,
  };
}
