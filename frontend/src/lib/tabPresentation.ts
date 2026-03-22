import type { WorktreeGitFileChange, WorktreeGitStatus } from "@/lib/api";
import {
  gitChangeTypeClass,
  gitChangeTypeLabel,
} from "@/lib/gitChangePresentation";
import { resolveMaterialFileIcon } from "@/lib/materialIconTheme";
import type { HubrisTheme } from "@/lib/theme/types";
import type { Tab } from "@/lib/types";

export type TabPresentation = {
  label: string;
  title: string;
  iconKind: "terminal" | "material";
  iconPath?: string;
  iconId?: string;
  toneClass?: string;
};

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function formatGitDiffScope(scope: "staged" | "unstaged"): string {
  return scope === "staged" ? "staged" : "unstaged";
}

function matchGitChange(
  changes: WorktreeGitFileChange[],
  path: string,
  originalPath?: string | null,
): WorktreeGitFileChange | null {
  return (
    changes.find(
      (change) =>
        change.path === path &&
        (change.original_path ?? null) === (originalPath ?? null),
    ) ??
    changes.find((change) => change.path === path) ??
    null
  );
}

function gitDiffChange(
  tab: Extract<Tab, { type: "git_diff" }>,
  gitStatus: WorktreeGitStatus | null,
): WorktreeGitFileChange | null {
  if (!gitStatus) {
    return null;
  }

  return matchGitChange(
    tab.scope === "staged" ? gitStatus.staged_files : gitStatus.unstaged_files,
    tab.path,
    tab.original_path,
  );
}

export function presentTab(
  tab: Tab,
  theme: HubrisTheme | null,
  gitStatus: WorktreeGitStatus | null,
): TabPresentation {
  if (tab.type === "terminal") {
    return {
      label: tab.label,
      title: tab.label,
      iconKind: "terminal",
    };
  }

  const icon = resolveMaterialFileIcon(tab.path, theme);

  if (tab.type === "file") {
    return {
      label: tab.label,
      title: tab.path,
      iconKind: "material",
      iconPath: icon.iconPath,
      iconId: icon.iconId,
    };
  }

  const change = gitDiffChange(tab, gitStatus);
  const statusLabel = change ? gitChangeTypeLabel(change.change_type) : null;
  const label = `[${formatGitDiffScope(tab.scope)}] ${baseName(tab.path)}${
    statusLabel ? ` ${statusLabel}` : ""
  }`;
  const title = `[${formatGitDiffScope(tab.scope)}] ${tab.path}${
    statusLabel ? ` ${statusLabel}` : ""
  }`;

  return {
    label,
    title,
    iconKind: "material",
    iconPath: icon.iconPath,
    iconId: icon.iconId,
    toneClass: change ? gitChangeTypeClass(change.change_type) : undefined,
  };
}
