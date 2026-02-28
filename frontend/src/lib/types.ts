export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Tab {
  id: string;
  session_id: string;
  project_id: string;
  label: string;
  type: 'terminal';
  position: number;
  created_at: number;
}

export interface DirEntry {
  name: string;
  is_git_repo: boolean;
}

export interface ListFilesResponse {
  path: string;
  entries: DirEntry[];
  home_dir: string | null;
}

// SSE event payloads
export interface SnapshotEvent {
  type: 'snapshot';
  data: { tabs: Tab[] };
}

export interface TabCreatedEvent {
  type: 'tab_created';
  data: Tab;
}

export interface TabClosedEvent {
  type: 'tab_closed';
  data: { tab_id: string };
}

export interface TabUpdatedEvent {
  type: 'tab_updated';
  data: Tab;
}

export type SyncEvent =
  | SnapshotEvent
  | TabCreatedEvent
  | TabClosedEvent
  | TabUpdatedEvent;
