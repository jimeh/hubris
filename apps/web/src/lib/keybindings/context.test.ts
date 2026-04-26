// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKeybindingWhenContext } from "./context";

const mocks = vi.hoisted(() => ({
  activeTab: { id: "tab-1", preview: false, type: "terminal" } as {
    id: string;
    preview: boolean;
    type: string;
  } | null,
}));

vi.mock("@/lib/commands", () => ({
  getCommandContextSnapshot: () => ({
    activeTab: mocks.activeTab,
    focusedPaneId: "pane-1",
    projects: [],
    selectedProject: { id: "project-1" },
    selectedWorktree: { id: "worktree-1" },
    tabs: [],
    worktrees: [],
    worktreesByProject: {},
  }),
}));

vi.mock("@/lib/stores/commandUi", () => ({
  useCommandUiStore: {
    getState: () => ({
      dialog: null,
      paletteOpen: false,
    }),
  },
}));

describe("keybinding context", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.activeTab = { id: "tab-1", preview: false, type: "terminal" };
  });

  it("only treats real terminal elements as terminal focus", () => {
    document.body.focus();

    expect(getKeybindingWhenContext(null).terminalFocus).toBe(false);

    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();

    expect(getKeybindingWhenContext(textarea).terminalFocus).toBe(true);
  });

  it("uses explicit browser and editor focus surfaces", () => {
    const appChrome = document.createElement("button");
    document.body.append(appChrome);
    appChrome.focus();

    mocks.activeTab = { id: "browser-1", preview: false, type: "browser" };
    expect(getKeybindingWhenContext(appChrome).browserFocus).toBe(false);

    const browserContent = document.createElement("div");
    browserContent.tabIndex = 0;
    browserContent.dataset.browserContent = "";
    document.body.append(browserContent);
    browserContent.focus();

    expect(getKeybindingWhenContext(browserContent).browserFocus).toBe(true);

    mocks.activeTab = { id: "file-1", preview: false, type: "file" };
    expect(getKeybindingWhenContext(appChrome).editorFocus).toBe(false);

    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();

    expect(getKeybindingWhenContext(editor).editorFocus).toBe(true);
  });

  it("detects git status focus only inside the git status surface", () => {
    const appChrome = document.createElement("button");
    document.body.append(appChrome);

    expect(getKeybindingWhenContext(appChrome).gitStatusFocus).toBe(false);

    const gitStatus = document.createElement("div");
    gitStatus.dataset.gitStatus = "";
    const action = document.createElement("button");
    gitStatus.append(action);
    document.body.append(gitStatus);

    expect(getKeybindingWhenContext(action).gitStatusFocus).toBe(true);
  });
});
