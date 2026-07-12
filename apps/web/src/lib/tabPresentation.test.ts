import { describe, expect, it } from "vitest";
import { presentTab } from "@/lib/tabPresentation";
import type { HubrisTheme } from "@/lib/theme/types";
import type { BrowserTab, FileTab, GitDiffTab, TerminalTab } from "@/lib/types";

const darkTheme: HubrisTheme = {
  id: "dark",
  name: "Dark",
  type: "dark",
  tokens: {},
} as HubrisTheme;

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    label: "Terminal 1",
    position: 1,
    worktreeId: "w1",
    paneId: "pane-1",
    sessionId: "default",
    type: "terminal",
    createdAt: 1,
    preview: false,
    ...overrides,
  };
}

function fileTab(overrides: Partial<FileTab> = {}): FileTab {
  return {
    id: "f1",
    label: "README.md",
    position: 1,
    worktreeId: "w1",
    paneId: "pane-1",
    sessionId: "default",
    type: "file",
    createdAt: 1,
    preview: false,
    path: "README.md",
    ...overrides,
  };
}

function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: "b1",
    label: "localhost",
    position: 1,
    worktreeId: "w1",
    paneId: "pane-1",
    sessionId: "default",
    type: "browser",
    createdAt: 1,
    preview: false,
    url: "http://localhost:3000/",
    history: ["http://localhost:3000/"],
    historyIndex: 0,
    ...overrides,
  };
}

function gitDiffTab(overrides: Partial<GitDiffTab> = {}): GitDiffTab {
  return {
    id: "d1",
    label: "lib.rs",
    position: 1,
    worktreeId: "w1",
    paneId: "pane-1",
    sessionId: "default",
    type: "git_diff",
    createdAt: 1,
    preview: true,
    path: "src/lib.rs",
    scope: "staged",
    originalPath: null,
    commitId: null,
    ...overrides,
  };
}

describe("tab presentation", () => {
  it("uses a terminal icon for terminal tabs", () => {
    expect(
      presentTab(terminalTab(), darkTheme, null, {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      }),
    ).toEqual({
      label: "Terminal 1",
      title: "Terminal 1",
      iconKind: "terminal",
    });
  });

  it("prefers custom terminal labels over dynamic labels", () => {
    expect(
      presentTab(
        terminalTab({
          customLabel: "Deploy",
          smartLabel: "bun",
          titleLabel: "watch dev",
        }),
        darkTheme,
        null,
        {
          smartTabNaming: true,
          escapeSequenceTitles: true,
        },
      ),
    ).toEqual({
      label: "Deploy",
      title: "Deploy",
      iconKind: "terminal",
    });
  });

  it("uses the smart label when smart naming is enabled", () => {
    expect(
      presentTab(
        terminalTab({
          smartLabel: "cargo",
          titleLabel: "server logs",
        }),
        darkTheme,
        null,
        {
          smartTabNaming: true,
          escapeSequenceTitles: false,
        },
      ),
    ).toEqual({
      label: "cargo",
      title: "cargo",
      iconKind: "terminal",
    });
  });

  it("uses the process title when escape-sequence titles are enabled", () => {
    expect(
      presentTab(
        terminalTab({
          smartLabel: "cargo",
          titleLabel: "server logs",
        }),
        darkTheme,
        null,
        {
          smartTabNaming: true,
          escapeSequenceTitles: true,
        },
      ),
    ).toEqual({
      label: "server logs",
      title: "server logs",
      iconKind: "terminal",
    });
  });

  it("falls back to the numbered label when smart naming is disabled", () => {
    expect(
      presentTab(
        terminalTab({
          smartLabel: "cargo",
          titleLabel: "server logs",
        }),
        darkTheme,
        null,
        {
          smartTabNaming: false,
          escapeSequenceTitles: false,
        },
      ),
    ).toEqual({
      label: "Terminal 1",
      title: "Terminal 1",
      iconKind: "terminal",
    });
  });

  it("uses the material icon resolver for file tabs", () => {
    const presentation = presentTab(
      fileTab({ path: "src/lib.rs", label: "lib.rs" }),
      darkTheme,
      null,
      {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      },
    );

    expect(presentation.iconKind).toBe("material");
    expect(presentation.iconId).toBe("rust");
    expect(presentation.label).toBe("lib.rs");
    expect(presentation.labelSuffix).toBeUndefined();
    expect(presentation.statusLabel).toBeUndefined();
    expect(presentation.title).toBe("src/lib.rs");
  });

  it("uses a browser icon and URL title for browser tabs", () => {
    expect(
      presentTab(browserTab(), darkTheme, null, {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      }),
    ).toEqual({
      label: "localhost",
      title: "http://localhost:3000/",
      iconKind: "browser",
    });
  });

  it("decorates git diff tabs with scope and status", () => {
    const presentation = presentTab(
      gitDiffTab(),
      darkTheme,
      {
        generation: 1,
        aheadCount: 0,
        aheadCommits: [],
        comparisonAvailable: true,
        unstagedFiles: [],
        stagedFiles: [{ path: "src/lib.rs", changeType: "modified" }],
      },
      {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      },
    );

    expect(presentation.label).toBe("lib.rs");
    expect(presentation.labelSuffix).toBe("(Index)");
    expect(presentation.statusLabel).toBe("M");
    expect(presentation.title).toBe("src/lib.rs (Index) M");
    expect(presentation.toneClass).toBe("text-amber-500");
    expect(presentation.iconId).toBe("rust");
  });

  it("matches diff status using originalPath when present", () => {
    const presentation = presentTab(
      gitDiffTab({
        path: "new-name.ts",
        originalPath: "old-name.ts",
        scope: "unstaged",
      }),
      darkTheme,
      {
        generation: 1,
        aheadCount: 0,
        aheadCommits: [],
        comparisonAvailable: true,
        stagedFiles: [],
        unstagedFiles: [
          {
            path: "new-name.ts",
            originalPath: "old-name.ts",
            changeType: "renamed",
          },
        ],
      },
      {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      },
    );

    expect(presentation.label).toBe("new-name.ts");
    expect(presentation.labelSuffix).toBe("(Working Tree)");
    expect(presentation.statusLabel).toBe("R");
    expect(presentation.toneClass).toBe("text-amber-500");
  });

  it("falls back cleanly when git status is unavailable", () => {
    const presentation = presentTab(gitDiffTab(), darkTheme, null, {
      smartTabNaming: true,
      escapeSequenceTitles: true,
    });

    expect(presentation.label).toBe("lib.rs");
    expect(presentation.labelSuffix).toBe("(Index)");
    expect(presentation.statusLabel).toBeUndefined();
    expect(presentation.title).toBe("src/lib.rs (Index)");
    expect(presentation.toneClass).toBeUndefined();
  });

  it("renders commit diff tabs without live status tone", () => {
    const presentation = presentTab(
      gitDiffTab({
        path: "src/lib.rs",
        scope: "commit",
        commitId: "abcdef123456",
      }),
      darkTheme,
      {
        generation: 1,
        aheadCount: 0,
        aheadCommits: [],
        comparisonAvailable: true,
        stagedFiles: [{ path: "src/lib.rs", changeType: "modified" }],
        unstagedFiles: [],
      },
      {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      },
    );

    expect(presentation.labelSuffix).toBe("(Commit abcdef1)");
    expect(presentation.statusLabel).toBeUndefined();
    expect(presentation.toneClass).toBeUndefined();
    expect(presentation.title).toBe("src/lib.rs (Commit abcdef1)");
  });
});
