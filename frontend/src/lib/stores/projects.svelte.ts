import {
  listProjects,
  addProject,
  deleteProject,
} from '$lib/api';
import type { Project } from '$lib/types';

let projects = $state<Project[]>([]);
let selected = $state<Project | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);

export function getProjectStore() {
  async function refresh() {
    loading = true;
    error = null;
    try {
      projects = await listProjects();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function add(path: string) {
    const project = await addProject(path);
    projects = [...projects, project];
    return project;
  }

  async function remove(id: string) {
    await deleteProject(id);
    projects = projects.filter((p) => p.id !== id);
    if (selected?.id === id) selected = null;
  }

  function select(project: Project) {
    selected = project;
  }

  return {
    get projects() {
      return projects;
    },
    get selected() {
      return selected;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    refresh,
    add,
    remove,
    select,
  };
}
