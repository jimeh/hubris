import type { Project } from './types';

const BASE = '/api';

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function addProject(
  path: string,
): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function deleteProject(
  id: string,
): Promise<void> {
  const res = await fetch(`${BASE}/projects/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export function terminalWsUrl(projectId: string): string {
  const proto =
    location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/terminal/ws?project_id=${projectId}`;
}
