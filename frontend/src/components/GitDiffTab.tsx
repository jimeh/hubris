import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { getProjectWorktreeGitDiff, type WorktreeGitDiff } from "@/lib/api";
import { applyMonacoTheme, getGitDiffModelPaths } from "@/lib/monaco";
import { useSettingsStore } from "@/lib/stores/settings";
import { useTerminalSettings } from "@/lib/stores/terminal";
import type { GitDiffTab } from "@/lib/types";

type Props = {
  projectId: string;
  worktreeId: string;
  tab: GitDiffTab;
};

type State =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; diff: WorktreeGitDiff };

function GitDiffTab({ projectId, worktreeId, tab }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const fontFamily = useTerminalSettings((store) => store.fontFamily);
  const fontSize = useTerminalSettings((store) => store.settings.fontSize);
  const modelPaths = useMemo(
    () =>
      getGitDiffModelPaths(
        worktreeId,
        tab.id,
        tab.path,
        tab.scope,
        tab.original_path,
      ),
    [worktreeId, tab.id, tab.path, tab.scope, tab.original_path],
  );
  const diffOptions = useMemo(
    () => ({
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily,
      fontSize,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
    }),
    [fontFamily, fontSize],
  );
  const handleBeforeMount = useCallback(() => {
    applyMonacoTheme(useSettingsStore.getState().activeTheme);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getProjectWorktreeGitDiff(
      projectId,
      worktreeId,
      tab.path,
      tab.scope,
      tab.original_path ?? undefined,
    )
      .then((diff) => {
        if (!cancelled) {
          setState({ status: "loaded", diff });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            error:
              error instanceof Error ? error.message : "Failed to load diff",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, tab.original_path, tab.path, tab.scope, worktreeId]);

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading diff
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {state.error}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {state.diff.unsupported_reason ? (
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {state.diff.unsupported_reason}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={state.diff.left_content}
          modified={state.diff.right_content}
          language={state.diff.language}
          originalModelPath={modelPaths.original}
          modifiedModelPath={modelPaths.modified}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          beforeMount={handleBeforeMount}
          options={diffOptions}
          theme="hubris"
        />
      </div>
    </div>
  );
}

function arePropsEqual(previous: Props, next: Props): boolean {
  return (
    previous.projectId === next.projectId &&
    previous.worktreeId === next.worktreeId &&
    previous.tab.id === next.tab.id &&
    previous.tab.path === next.tab.path &&
    previous.tab.scope === next.tab.scope &&
    (previous.tab.original_path ?? null) === (next.tab.original_path ?? null)
  );
}

export default memo(GitDiffTab, arePropsEqual);
