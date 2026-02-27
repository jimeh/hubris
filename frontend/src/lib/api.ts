import type { ListFilesResponse, Project } from './types';

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

export async function listFiles(
  path?: string,
  showHidden = false,
): Promise<ListFilesResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (showHidden) params.set('show_hidden', 'true');

  const res = await fetch(
    `${BASE}/files?${params.toString()}`,
  );
  if (!res.ok) {
    if (res.status === 404)
      throw new Error('Directory not found');
    if (res.status === 403)
      throw new Error('Permission denied');
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export function terminalWsUrl(projectId: string): string {
  const proto =
    location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/terminal/ws?project_id=${projectId}`;
}
