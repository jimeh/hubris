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
