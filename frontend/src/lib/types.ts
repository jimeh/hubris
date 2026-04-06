import type { components } from "@/lib/contracts/rest.generated";

export type Project = components["schemas"]["Project"];
export type Worktree = components["schemas"]["Worktree"];
export type Tab = components["schemas"]["TabInfo"];
export type TerminalTab = Extract<Tab, { type: "terminal" }>;
export type FileTab = Extract<Tab, { type: "file" }>;
export type GitDiffTab = Extract<Tab, { type: "git_diff" }>;
export type DirEntry = components["schemas"]["DirEntry"];
export type ListFilesResponse = components["schemas"]["ListFilesResponse"];
export type WorktreeFileKind = components["schemas"]["WorktreeFileKind"];
export type WorktreeFileEntry = components["schemas"]["WorktreeFileEntry"];
export type ListWorktreeFilesResponse =
  components["schemas"]["ListWorktreeFilesResponse"];
export type RenameWorktreeFileResponse =
  components["schemas"]["RenameWorktreeFileResponse"];
export type GitDiffScope = components["schemas"]["GitDiffScope"];
export type WorktreeFileContentResponse =
  components["schemas"]["WorktreeFileContentResponse"];
export type WorktreeGitDiffResponse =
  components["schemas"]["WorktreeGitDiffResponse"];
export type SystemInfo = components["schemas"]["SystemInfo"];
