import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { buildCommandContextSnapshot } from "./context";
import { getCommandDefinition } from "./registry";
import { executeCommand } from "./runtime";
import type { CommandArgsById, CommandId, CommandSource } from "./types";

export function useCommandContext() {
  const projects = useProjectStore((state) => state.projects);
  const worktreeState = useWorktreeStore(
    useShallow((state) => ({
      selectedWorktreeId: state.selectedWorktreeId,
      worktreesByProject: state.worktreesByProject,
    })),
  );
  const tabState = useTabStore(
    useShallow((state) => ({
      activeTabId: state.activeTabId,
      focusedPaneByWorktree: state.focusedPaneByWorktree,
      tabs: state.tabs,
    })),
  );

  return useMemo(
    () =>
      buildCommandContextSnapshot({
        activeTabId: tabState.activeTabId,
        focusedPaneByWorktree: tabState.focusedPaneByWorktree,
        projects,
        selectedWorktreeId: worktreeState.selectedWorktreeId,
        tabs: tabState.tabs,
        worktreesByProject: worktreeState.worktreesByProject,
      }),
    [
      projects,
      tabState.activeTabId,
      tabState.focusedPaneByWorktree,
      tabState.tabs,
      worktreeState.selectedWorktreeId,
      worktreeState.worktreesByProject,
    ],
  );
}

export function useCommandAction<TId extends CommandId>(
  id: TId,
  args?: CommandArgsById[TId],
  source: CommandSource = "button",
) {
  const context = useCommandContext();
  const definition = getCommandDefinition(id);
  const availability = definition.isAvailable(context, args);

  const run = useCallback(async () => {
    return executeCommand({ args, id, source });
  }, [args, id, source]);

  return {
    availability,
    disabled: !availability.enabled,
    icon: definition.icon,
    keywords: definition.keywords ?? [],
    run,
    title: definition.title,
  };
}
