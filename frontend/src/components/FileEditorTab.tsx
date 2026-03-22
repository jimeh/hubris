import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  type ComponentProps,
} from "react";
import Editor from "@monaco-editor/react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyMonacoTheme, getFileModelPath } from "@/lib/monaco";
import { useFileEditorStore } from "@/lib/stores/fileEditorTabs";
import { useSettingsStore } from "@/lib/stores/settings";
import { useTabStore } from "@/lib/stores/tabs";
import { useTerminalSettings } from "@/lib/stores/terminal";
import type { FileTab } from "@/lib/types";

type Props = {
  projectId: string;
  worktreeId: string;
  tab: FileTab;
  visible: boolean;
};

function FileEditorTab({ projectId, worktreeId, tab, visible }: Props) {
  const session = useFileEditorStore((state) => state.sessions[tab.id]);
  const ensureLoaded = useFileEditorStore((state) => state.ensureLoaded);
  const updateDraft = useFileEditorStore((state) => state.updateDraft);
  const save = useFileEditorStore((state) => state.save);
  const reload = useFileEditorStore((state) => state.reload);
  const clearExternalChange = useFileEditorStore(
    (state) => state.clearExternalChange,
  );
  const pin = useTabStore((state) => state.pin);
  const fontFamily = useTerminalSettings((state) => state.fontFamily);
  const fontSize = useTerminalSettings((state) => state.settings.fontSize);
  const modelPath = getFileModelPath(worktreeId, tab);
  const editorOptions = useMemo(
    () => ({
      readOnly: session?.readOnly ?? false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily,
      fontSize,
      wordWrap: "off" as const,
      renderWhitespace: "selection" as const,
      scrollBeyondLastLine: false,
      tabSize: 2,
    }),
    [fontFamily, fontSize, session?.readOnly],
  );
  const handleBeforeMount = useCallback(() => {
    applyMonacoTheme(useSettingsStore.getState().activeTheme);
  }, []);
  const handleChange = useCallback(
    (value: string | undefined) => {
      const nextValue = value ?? "";
      if (tab.preview && !session?.dirty) {
        void pin(tab.id);
      }
      updateDraft(tab.id, nextValue);
    },
    [pin, session?.dirty, tab.id, tab.preview, updateDraft],
  );
  const handleMount = useCallback(
    (
      editor: Parameters<
        NonNullable<ComponentProps<typeof Editor>["onMount"]>
      >[0],
      monaco: Parameters<
        NonNullable<ComponentProps<typeof Editor>["onMount"]>
      >[1],
    ) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void save(projectId, worktreeId, tab.id);
      });
    },
    [projectId, save, tab.id, worktreeId],
  );

  useEffect(() => {
    void ensureLoaded(projectId, worktreeId, tab);
  }, [ensureLoaded, projectId, tab, worktreeId]);

  if (!session || session.loadStatus === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading {tab.path}
      </div>
    );
  }

  if (session.loadStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p>{session.error ?? "Failed to load file."}</p>
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
        <Editor
          path={modelPath}
          language={session.language}
          value={session.draft}
          saveViewState
          keepCurrentModel
          beforeMount={handleBeforeMount}
          options={editorOptions}
          onChange={handleChange}
          onMount={handleMount}
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
            onClick={() => void save(projectId, worktreeId, tab.id)}
          >
            {session.saveStatus === "saving" ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
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
    previous.tab.preview === next.tab.preview
  );
}

export default memo(FileEditorTab, arePropsEqual);
