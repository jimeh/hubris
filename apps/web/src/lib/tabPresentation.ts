import type { WorktreeGitFileChange, WorktreeGitStatus } from "@/lib/api";
import { browserLabelFromUrl } from "@/lib/browserTabs";
import {
  gitChangeTypeClass,
  gitChangeTypeLabel,
} from "@/lib/gitChangePresentation";
import { resolveMaterialFileIcon } from "@/lib/materialIconTheme";
import type { TerminalSettings } from "@/lib/theme/types";
import type { HubrisTheme } from "@/lib/theme/types";
import type { GitDiffTab, Tab } from "@/lib/types";

export type TabPresentation = {
  label: string;
  labelSuffix?: string;
  statusLabel?: string;
  title: string;
  iconKind: "terminal" | "material" | "browser" | "chat";
  iconPath?: string;
  iconId?: string;
  toneClass?: string;
};

type TerminalTabPresentationSettings = Pick<
  TerminalSettings,
  "smartTabNaming" | "escapeSequenceTitles"
>;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function shortCommitId(commitId: string | null | undefined): string | null {
  if (!commitId) {
    return null;
  }
  return commitId.slice(0, 7);
}

function formatGitDiffScope(tab: GitDiffTab): string {
  if (tab.scope === "staged") {
    return "Index";
  }
  if (tab.scope === "unstaged") {
    return "Working Tree";
  }

  const commitLabel = shortCommitId(tab.commitId);
  return commitLabel ? `Commit ${commitLabel}` : "Commit";
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
        (change.originalPath ?? null) === (originalPath ?? null),
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

  if (tab.scope === "commit") {
    return null;
  }

  return matchGitChange(
    tab.scope === "staged" ? gitStatus.stagedFiles : gitStatus.unstagedFiles,
    tab.path,
    tab.originalPath,
  );
}

function terminalTabLabel(
  tab: Extract<Tab, { type: "terminal" }>,
  terminalSettings: TerminalTabPresentationSettings,
): string {
  if (tab.customLabel) {
    return tab.customLabel;
  }

  if (terminalSettings.escapeSequenceTitles && tab.titleLabel) {
    return tab.titleLabel;
  }

  if (terminalSettings.smartTabNaming && tab.smartLabel) {
    return tab.smartLabel;
  }

  return tab.label;
}

export function presentTab(
  tab: Tab,
  theme: HubrisTheme | null,
  gitStatus: WorktreeGitStatus | null,
  terminalSettings: TerminalTabPresentationSettings,
): TabPresentation {
  if (tab.type === "terminal") {
    const label = terminalTabLabel(tab, terminalSettings);
    return {
      label,
      title: label,
      iconKind: "terminal",
    };
  }

  if (tab.type === "browser") {
    const label = tab.label || browserLabelFromUrl(tab.url);
    return {
      label,
      title: tab.url,
      iconKind: "browser",
    };
  }

  if (tab.type === "agent_chat") {
    const label = tab.label || "New Chat";
    return {
      label,
      title: label,
      iconKind: "chat",
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
  const statusLabel = change ? gitChangeTypeLabel(change.changeType) : null;
  const scopeLabel = `(${formatGitDiffScope(tab)})`;
  const label = baseName(tab.path);
  const title = `${tab.path} ${scopeLabel}${
    statusLabel ? ` ${statusLabel}` : ""
  }`;

  return {
    label,
    labelSuffix: scopeLabel,
    statusLabel: statusLabel ?? undefined,
    title,
    iconKind: "material",
    iconPath: icon.iconPath,
    iconId: icon.iconId,
    toneClass: change ? gitChangeTypeClass(change.changeType) : undefined,
  };
}
