import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { buildCommandContextSnapshot } from "@/lib/commands/context";
import { getCommandDefinition } from "@/lib/commands/registry";
import { executeCommand } from "@/lib/commands/runtime";
import type {
  CommandArgsById,
  CommandId,
  CommandSource,
} from "@/lib/commands/types";
import { useProjectStore } from "@/lib/stores/projects";
import { selectAllTabs, useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";

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
      tabs: selectAllTabs(state),
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
  const serializedArgs = useMemo(() => JSON.stringify(args ?? null), [args]);
  const stableArgs = useMemo(
    () =>
      serializedArgs === "null"
        ? undefined
        : (JSON.parse(serializedArgs) as CommandArgsById[TId]),
    [serializedArgs],
  );
  const availability = definition.isAvailable(context, stableArgs);

  const run = useCallback(async () => {
    return executeCommand({ args: stableArgs, id, source });
  }, [id, source, stableArgs]);

  return {
    availability,
    disabled: !availability.enabled,
    icon: definition.icon,
    keywords: definition.keywords ?? [],
    run,
    title: definition.title,
  };
}
