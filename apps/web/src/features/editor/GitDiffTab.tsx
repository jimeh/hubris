import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import type { TabBarAction } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { applyMonacoTheme, getGitDiffModelPaths } from "@/lib/monaco";
import { DiffEditor } from "@/lib/heavy/monacoReact";
import { useGitDiffStore } from "@/lib/stores/gitDiffTabs";
import { useSettingsStore } from "@/lib/stores/settings";
import { useTabStore } from "@/lib/stores/tabs";
import { useTerminalSettings } from "@/lib/stores/terminal";
import type { GitDiffTab as GitDiffTabType } from "@/lib/types";

type Props = {
  projectId: string;
  worktreeId: string;
  tab: GitDiffTabType;
  visible: boolean;
  setTabBarActionsForTab?: (
    tabId: string,
    actions: TabBarAction[] | null,
  ) => void;
};

type DiffEditorInstance = Parameters<
  NonNullable<ComponentProps<typeof DiffEditor>["onMount"]>
>[0];

function GitDiffTab({
  projectId,
  worktreeId,
  tab,
  visible,
  setTabBarActionsForTab,
}: Props) {
  const session = useGitDiffStore((state) => state.sessions[tab.id]);
  const ensureLoaded = useGitDiffStore((state) => state.ensureLoaded);
  const updateDraft = useGitDiffStore((state) => state.updateDraft);
  const save = useGitDiffStore((state) => state.save);
  const reload = useGitDiffStore((state) => state.reload);
  const clearExternalChange = useGitDiffStore(
    (state) => state.clearExternalChange,
  );
  const pin = useTabStore((state) => state.pin);
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
        tab.commit_id,
      ),
    [worktreeId, tab.commit_id, tab.id, tab.original_path, tab.path, tab.scope],
  );
  const diffOptions = useMemo(
    () => ({
      readOnly: session?.readOnly ?? true,
      originalEditable: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily,
      fontSize,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
    }),
    [fontFamily, fontSize, session?.readOnly],
  );
  const handleBeforeMount = useCallback(() => {
    const state = useSettingsStore.getState();
    applyMonacoTheme(state.activeTheme, state.editorThemeData);
  }, []);
  const changeDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const diffEditorRef = useRef<DiffEditorInstance | null>(null);
  const [diffEditorReady, setDiffEditorReady] = useState(false);

  const goToPreviousChange = useCallback(() => {
    diffEditorRef.current?.goToDiff("previous");
  }, []);
  const goToNextChange = useCallback(() => {
    diffEditorRef.current?.goToDiff("next");
  }, []);
  const tabBarActions = useMemo<TabBarAction[]>(
    () => [
      {
        id: "previous-change",
        icon: ChevronUp,
        label: "Previous Change",
        onClick: goToPreviousChange,
        disabled: !diffEditorReady,
      },
      {
        id: "next-change",
        icon: ChevronDown,
        label: "Next Change",
        onClick: goToNextChange,
        disabled: !diffEditorReady,
      },
    ],
    [diffEditorReady, goToNextChange, goToPreviousChange],
  );

  const handleMount = useCallback(
    (
      editor: Parameters<
        NonNullable<ComponentProps<typeof DiffEditor>["onMount"]>
      >[0],
      monaco: Parameters<
        NonNullable<ComponentProps<typeof DiffEditor>["onMount"]>
      >[1],
    ) => {
      diffEditorRef.current = editor;
      setDiffEditorReady(true);
      const modifiedEditor = editor.getModifiedEditor();

      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = modifiedEditor.onDidChangeModelContent(
        () => {
          const nextValue = modifiedEditor.getValue();
          const currentDraft =
            useGitDiffStore.getState().sessions[tab.id]?.draft ?? "";
          if (nextValue === currentDraft) {
            return;
          }
          const isDirty = useGitDiffStore.getState().sessions[tab.id]?.dirty;
          if (tab.preview && !isDirty) {
            void pin(tab.id);
          }
          updateDraft(tab.id, nextValue);
        },
      );
      modifiedEditor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void save(projectId, worktreeId, tab.id).catch(() => {});
        },
      );
    },
    [pin, projectId, save, tab.id, tab.preview, updateDraft, worktreeId],
  );

  useEffect(() => {
    void ensureLoaded(projectId, worktreeId, tab);
  }, [ensureLoaded, projectId, tab, worktreeId]);

  useEffect(() => {
    setTabBarActionsForTab?.(tab.id, tabBarActions);
  }, [setTabBarActionsForTab, tab.id, tabBarActions]);

  useEffect(
    () => () => {
      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = null;
      diffEditorRef.current = null;
      setTabBarActionsForTab?.(tab.id, null);
    },
    [setTabBarActionsForTab, tab.id],
  );

  if (!session || session.loadStatus === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        Loading diff
      </div>
    );
  }

  if (session.loadStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p>{session.error ?? "Failed to load diff."}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void ensureLoaded(projectId, worktreeId, tab)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {session.externalChange ? (
        <div className="flex items-center justify-between border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <span>
            This file changed on disk. Reload to sync with the latest version.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              clearExternalChange(tab.id);
              void reload(projectId, worktreeId, tab.id);
            }}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      ) : null}
      {session.error && session.saveStatus === "error" ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {session.error}
        </div>
      ) : null}
      {session.readOnly && session.unsupportedReason ? (
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {session.unsupportedReason}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={session.originalContent}
          modified={session.draft}
          language={session.language}
          originalModelPath={modelPaths.original}
          modifiedModelPath={modelPaths.modified}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          beforeMount={handleBeforeMount}
          onMount={handleMount}
          options={diffOptions}
          theme="hubris"
        />
      </div>
      {!session.readOnly ? (
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span>{session.dirty ? "Unsaved changes" : "Saved"}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              !session.dirty || session.saveStatus === "saving" || !visible
            }
            onClick={() =>
              void save(projectId, worktreeId, tab.id).catch(() => {})
            }
          >
            {session.saveStatus === "saving" ? (
              <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-2 h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function arePropsEqual(previous: Props, next: Props): boolean {
  return (
    previous.projectId === next.projectId &&
    previous.worktreeId === next.worktreeId &&
    previous.visible === next.visible &&
    previous.tab.id === next.tab.id &&
    previous.tab.path === next.tab.path &&
    previous.tab.scope === next.tab.scope &&
    (previous.tab.original_path ?? null) === (next.tab.original_path ?? null) &&
    (previous.tab.commit_id ?? null) === (next.tab.commit_id ?? null)
  );
}

export default memo(GitDiffTab, arePropsEqual);
