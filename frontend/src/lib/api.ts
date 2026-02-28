import type { ListFilesResponse, Project, Tab } from './types';
import type { AppearanceSettings, HubrisTheme } from './theme/types';

const BASE = '/api';

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function addProject(path: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
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

  const res = await fetch(`${BASE}/files?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Directory not found');
    if (res.status === 403) throw new Error('Permission denied');
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function listTabs(): Promise<Tab[]> {
  const res = await fetch(`${BASE}/tabs`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function createTab(projectId: string): Promise<Tab> {
  const res = await fetch(`${BASE}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function deleteTab(id: string): Promise<void> {
  const res = await fetch(`${BASE}/tabs/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
}

export async function updateTab(
  id: string,
  updates: { label?: string; position?: number },
): Promise<Tab> {
  const res = await fetch(`${BASE}/tabs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function terminalWsUrl(tabId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/terminal/ws?tab_id=${encodeURIComponent(tabId)}`;
}

// --- Settings ---

export async function getSettings(): Promise<{
  appearance?: AppearanceSettings;
}> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function saveSettings(value: {
  appearance: AppearanceSettings;
}): Promise<void> {
  // Also cache in localStorage for FOUC script
  localStorage.setItem('hubris-appearance', JSON.stringify(value.appearance));
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

// --- User Themes ---

export async function listUserThemes(): Promise<HubrisTheme[]> {
  const res = await fetch(`${BASE}/themes`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getUserTheme(id: string): Promise<HubrisTheme> {
  const res = await fetch(`${BASE}/themes/${id}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function uploadUserTheme(theme: HubrisTheme): Promise<void> {
  const res = await fetch(`${BASE}/themes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(theme),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function deleteUserTheme(id: string): Promise<void> {
  const res = await fetch(`${BASE}/themes/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
}
