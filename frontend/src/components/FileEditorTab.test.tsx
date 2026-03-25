// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@/lib/types";

const ensureLoaded = vi.fn();
const updateDraft = vi.fn();
const save = vi.fn().mockResolvedValue(undefined);
const reload = vi.fn();
const clearExternalChange = vi.fn();
const pin = vi.fn();

const session = {
  tabId: "file-1",
  path: "escape-link",
  draft: "",
  savedContent: "",
  versionToken: "",
  language: "plaintext",
  readOnly: false,
  unsupportedReason: null,
  dirty: false,
  externalChange: false,
  loadStatus: "error" as const,
  saveStatus: "idle" as const,
  error:
    "This path resolves outside the allowed roots. Only files inside this worktree or symlinks into the repository root can be opened.",
};

vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="editor" />,
}));

vi.mock("@/lib/monaco", () => ({
  applyMonacoTheme: vi.fn(),
  getFileModelPath: () => "inmemory://file-1",
}));

vi.mock("@/lib/stores/fileEditorTabs", () => ({
  useFileEditorStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: { "file-1": session },
      ensureLoaded,
      updateDraft,
      save,
      reload,
      clearExternalChange,
    }),
}));

vi.mock("@/lib/stores/tabs", () => ({
  useTabStore: (selector: (state: unknown) => unknown) =>
    selector({
      pin,
    }),
}));

vi.mock("@/lib/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ activeTheme: "hubris" }),
  },
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalSettings: (selector: (state: unknown) => unknown) =>
    selector({
      fontFamily: "Iosevka",
      settings: { fontSize: 14 },
    }),
}));

function makeTab(overrides: Partial<FileTab> = {}): FileTab {
  return {
    id: "file-1",
    label: "escape-link",
    position: 1,
    worktree_id: "w1",
    session_id: "default",
    type: "file",
    created_at: 0,
    preview: false,
    path: "escape-link",
    ...overrides,
  };
}

describe("FileEditorTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows backend denied-path messages verbatim", async () => {
    const { default: FileEditorTab } = await import("./FileEditorTab");

    render(
      <FileEditorTab projectId="p1" worktreeId="w1" tab={makeTab()} visible />,
    );

    expect(
      screen.getByText(/resolves outside the allowed roots/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
