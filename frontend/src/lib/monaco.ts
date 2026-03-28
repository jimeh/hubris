import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { HubrisTheme } from "@/lib/theme/types";
import type { FileTab, GitDiffTab, Tab } from "@/lib/types";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (_workerId: string, label: string) => Worker;
    };
  }
}

const HUBRIS_THEME_NAME = "hubris";

let configured = false;
let appliedThemeSignature: string | null = null;

export function configureMonaco(): void {
  if (configured) {
    return;
  }
  configured = true;

  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
}

export function applyMonacoTheme(theme: HubrisTheme | null): void {
  configureMonaco();
  const base = theme?.type === "light" ? "vs" : "vs-dark";
  const colors = {
    background: theme?.tokens["terminal-background"] ?? "#111827",
    foreground: theme?.tokens["terminal-foreground"] ?? "#e5e7eb",
    mutedForeground: theme?.tokens["muted-foreground"] ?? "#9ca3af",
    cursor: theme?.tokens["terminal-cursor"] ?? "#93c5fd",
    selection: theme?.tokens["terminal-selection"] ?? "#374151",
    widget: theme?.tokens.card ?? "#1f2937",
    border: theme?.tokens.border ?? "#374151",
    input: theme?.tokens.input ?? "#374151",
  };
  const signature = JSON.stringify({ base, colors });

  if (appliedThemeSignature === signature) {
    return;
  }
  appliedThemeSignature = signature;

  monaco.editor.defineTheme(HUBRIS_THEME_NAME, {
    base,
    inherit: true,
    colors: {
      "editor.background": colors.background,
      "editor.foreground": colors.foreground,
      "editorLineNumber.foreground": colors.mutedForeground,
      "editorLineNumber.activeForeground": colors.foreground,
      "editorCursor.foreground": colors.cursor,
      "editor.selectionBackground": colors.selection,
      "editor.inactiveSelectionBackground": colors.selection,
      "editorWidget.background": colors.widget,
      "editorWidget.border": colors.border,
      "editorGutter.background": colors.background,
      "editorIndentGuide.background1": colors.border,
      "editorIndentGuide.activeBackground1": colors.input,
      "diffEditor.insertedTextBackground": "#16a34a33",
      "diffEditor.removedTextBackground": "#dc262633",
    },
    rules: [],
  });
  monaco.editor.setTheme(HUBRIS_THEME_NAME);
}

export function getFileModelPath(worktreeId: string, tab: FileTab): string {
  return `hubris-file:///${worktreeId}/${tab.id}?path=${encodeURIComponent(
    tab.path,
  )}`;
}

export function getGitDiffModelPaths(
  worktreeId: string,
  tabId: string,
  path: string,
  scope: GitDiffTab["scope"],
  originalPath?: string | null,
): { original: string; modified: string } {
  const base = `hubris-diff:///${worktreeId}/${tabId}`;
  const query = new URLSearchParams({
    path,
    scope,
  });
  if (originalPath) {
    query.set("originalPath", originalPath);
  }

  return {
    original: `${base}/original?${query.toString()}`,
    modified: `${base}/modified?${query.toString()}`,
  };
}

function disposeModel(modelPath: string): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(modelPath));
  model?.dispose();
}

export function scheduleDisposeTabModels(tab: Tab): void {
  if (tab.type === "terminal") {
    return;
  }

  const action =
    tab.type === "file"
      ? () => {
          disposeModel(getFileModelPath(tab.worktree_id, tab));
        }
      : () => {
          const modelPaths = getGitDiffModelPaths(
            tab.worktree_id,
            tab.id,
            tab.path,
            tab.scope,
            tab.original_path,
          );
          disposeModel(modelPaths.original);
          disposeModel(modelPaths.modified);
        };

  window.setTimeout(action, 0);
}

export { monaco, HUBRIS_THEME_NAME };
