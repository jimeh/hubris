import type { GitStatusAction } from "@/lib/stores/gitStatus";

export type TreeOpenState = Record<string, boolean>;
export type ChangeSection = "unstaged" | "staged";
export type DiffScope = ChangeSection | "commit";
export type SectionKey = ChangeSection | "commits";
export type SectionOpenState = Record<SectionKey, boolean>;

export type OpenGitDiff = (
  path: string,
  scope: DiffScope,
  originalPath: string | undefined,
  commitId: string | undefined,
  preview: boolean,
) => void;

export type DispatchGitAction = (
  action: GitStatusAction,
  path: string,
  originalPath: string | undefined,
  label: string,
  recursive: boolean,
) => void;
