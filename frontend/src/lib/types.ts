export interface Project {
  id: string;
  name: string;
  path: string;
  position: number;
  git_error?: string;
}

export interface Worktree {
  id: string;
  project_id: string;
  name: string;
  path: string;
  branch: string;
  is_local: boolean;
  missing_on_disk: boolean;
  position: number;
}

export interface Tab {
  id: string;
  session_id: string;
  worktree_id: string;
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
