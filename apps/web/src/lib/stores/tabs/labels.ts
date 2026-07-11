import type { Tab } from "@/lib/types";

function tabKey(tab: Tab): string {
  switch (tab.type) {
    case "terminal":
      return [
        tab.id,
        tab.label,
        tab.customLabel ?? "",
        tab.smartLabel ?? "",
        tab.titleLabel ?? "",
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.has_notification ?? false,
      ].join("|");
    case "file":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.path,
      ].join("|");
    case "git_diff":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.path,
        tab.scope,
        tab.original_path ?? "",
        tab.commit_id ?? "",
      ].join("|");
    case "browser":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.url,
        tab.history.join("||"),
        tab.history_index,
      ].join("|");
    case "agent_chat":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.conversation_id,
      ].join("|");
  }
}

export function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (tabKey(a[index]) !== tabKey(b[index])) {
      return false;
    }
  }
  return true;
}
