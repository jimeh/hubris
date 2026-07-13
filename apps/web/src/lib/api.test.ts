// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addProject,
  createProjectWorktree,
  createTab,
  deleteProject,
  deleteProjectWorktree,
  deleteTab,
  getProjectWorktreeCommitDetails,
  getProjectWorktreeFileContent,
  getProjectWorktreeGitDiff,
  getProjectWorktreeGitStatus,
  getSettings,
  listFiles,
  listProjectWorktreeFiles,
  listProjectWorktreeStartPoints,
  listProjects,
  listTabs,
  patchSettings,
  replaceSettings,
  reorderProjects,
  resetApiStateForTests,
  saveProjectWorktreeFileContent,
  stageProjectWorktreePath,
  terminalWsUrl,
  unstageProjectWorktreePath,
  updateProject,
  updateTab,
} from "./api";

// Mock location for terminalWsUrl
vi.stubGlobal("location", {
  protocol: "http:",
  host: "localhost:5173",
});

const okStatus = {
  kind: "ok" as const,
  writesBlocked: false,
  message: null,
};

describe("API client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetApiStateForTests();
  });

  describe("listProjects", () => {
    it("fetches from /api/projects and returns JSON", async () => {
      const mockProjects = [{ id: "1", name: "test", path: "/test" }];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        }),
      );

      const result = await listProjects();
      expect(fetch).toHaveBeenCalledWith("/api/projects");
      expect(result).toEqual(mockProjects);
    });

    it("throws on non-OK response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(listProjects()).rejects.toThrow("500");
    });
  });

  describe("addProject", () => {
    it("sends POST with path in body", async () => {
      const mockProject = {
        id: "2",
        name: "myrepo",
        path: "/home/user/myrepo",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProject),
        }),
      );

      const result = await addProject("/home/user/myrepo");
      expect(fetch).toHaveBeenCalledWith("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/home/user/myrepo" }),
      });
      expect(result).toEqual(mockProject);
    });
  });

  describe("updateProject", () => {
    it("sends PATCH with name", async () => {
      const mockProject = {
        id: "p1",
        name: "Renamed",
        path: "/test",
        position: 1.0,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProject),
        }),
      );

      const result = await updateProject("p1", { name: "Renamed" });
      expect(fetch).toHaveBeenCalledWith("/api/projects/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(result).toEqual(mockProject);
    });
  });

  describe("reorderProjects", () => {
    it("sends PUT with projectIds", async () => {
      const mockProjects = [
        { id: "p2", name: "var", path: "/var", position: 1.0 },
        { id: "p1", name: "tmp", path: "/tmp", position: 2.0 },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        }),
      );

      const result = await reorderProjects(["p2", "p1"]);
      expect(fetch).toHaveBeenCalledWith("/api/projects/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: ["p2", "p1"] }),
      });
      expect(result).toEqual(mockProjects);
    });
  });

  describe("deleteProject", () => {
    it("sends DELETE to /api/projects/:id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject("abc-123");
      expect(fetch).toHaveBeenCalledWith("/api/projects/abc-123", {
        method: "DELETE",
      });
    });

    it("sends deleteManagedWorktrees for managed deletion", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject("abc-123", { deleteManagedWorktrees: true });

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/abc-123?deleteManagedWorktrees=true",
        {
          method: "DELETE",
        },
      );
    });

    it("sends both deleteManagedWorktrees and force when forcing deletion", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject("abc-123", {
        deleteManagedWorktrees: true,
        force: true,
      });

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/abc-123?deleteManagedWorktrees=true&force=true",
        {
          method: "DELETE",
        },
      );
    });

    it("tolerates 404 (already gone)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      // Should not throw
      await deleteProject("abc-123");
    });

    it("throws on non-404 errors", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(deleteProject("abc-123")).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 500,
      });
    });
  });

  describe("deleteProjectWorktree", () => {
    it("sends DELETE to /api/projects/:projectId/worktrees/:worktreeId", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProjectWorktree("p1", "w1");

      expect(fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees/w1", {
        method: "DELETE",
      });
    });

    it("throws ApiStatusError on non-404 failures", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
        }),
      );

      await expect(deleteProjectWorktree("p1", "w1")).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 409,
      });
    });

    it("tolerates 404 (already gone)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      await expect(deleteProjectWorktree("p1", "w1")).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees/w1", {
        method: "DELETE",
      });
    });
  });

  describe("listProjectWorktreeStartPoints", () => {
    it("fetches start points for a project", async () => {
      const mockResponse = {
        startPoints: [
          {
            value: "main",
            sha: "abc123",
            localRef: "main",
            remoteRefs: ["origin/main"],
          },
        ],
        defaultStartPoint: "main",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await listProjectWorktreeStartPoints("p1");
      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/start-points",
      );
      expect(result).toEqual(mockResponse);
    });

    it("throws on non-OK response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(listProjectWorktreeStartPoints("p1")).rejects.toThrow("500");
    });
  });

  describe("createProjectWorktree", () => {
    it("sends POST with branch, start point, and source ref", async () => {
      const mockWorktree = {
        id: "w1",
        projectId: "p1",
        name: "feature-test",
        path: "/tmp/w1",
        branch: "feature-test",
        sourceRef: "origin/main",
        isLocal: false,
        missingOnDisk: false,
        position: 2,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        }),
      );

      const result = await createProjectWorktree(
        "p1",
        "feature-test",
        "origin/main",
        "origin/main",
      );
      expect(fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: "feature-test",
          startPoint: "origin/main",
          sourceRef: "origin/main",
        }),
      });
      expect(result).toEqual(mockWorktree);
    });

    it("omits startPoint when not provided", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: "w1" }),
        }),
      );

      await createProjectWorktree("p1", "feature-test");
      expect(fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "feature-test" }),
      });
    });
  });

  describe("getProjectWorktreeGitStatus", () => {
    it("fetches git status for a worktree", async () => {
      const mockStatus = {
        sourceRef: "origin/main",
        unstagedFiles: [],
        stagedFiles: [],
        aheadCount: 0,
        aheadCommits: [],
        comparisonAvailable: true,
        comparisonError: null,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockStatus),
        }),
      );

      const result = await getProjectWorktreeGitStatus("p1", "w1");

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/w1/git-status",
      );
      expect(result).toEqual(mockStatus);
    });
  });

  describe("getProjectWorktreeCommitDetails", () => {
    it("fetches commit details for a worktree commit", async () => {
      const mockDetails = {
        id: "abcdef123456",
        shortId: "abcdef1",
        summary: "feat: commit details",
        message: "feat: commit details\n\nmore",
        author: {
          name: "Author",
          email: "author@example.com",
          date: "2026-03-19T12:00:00+00:00",
        },
        committer: {
          name: "Committer",
          email: "committer@example.com",
          date: "2026-03-19T12:30:00+00:00",
        },
        files: [{ path: "src/main.ts", changeType: "modified" }],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockDetails),
        }),
      );

      const result = await getProjectWorktreeCommitDetails(
        "p1",
        "w1",
        "abcdef123456",
      );

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/w1/git/commits/abcdef123456",
      );
      expect(result).toEqual(mockDetails);
    });

    it("throws a readable error for unknown commits", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ message: "Commit not found" }),
        }),
      );

      await expect(
        getProjectWorktreeCommitDetails("p1", "w1", "deadbeef"),
      ).rejects.toThrow("Commit not found");
    });
  });

  describe("worktree git path actions", () => {
    it("sends originalPath when staging a renamed or copied path", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await stageProjectWorktreePath(
        "p1",
        "w1",
        "new/target.txt",
        "old/source.txt",
      );

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/w1/git/stage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "new/target.txt",
            originalPath: "old/source.txt",
          }),
        },
      );
    });

    it("omits originalPath for normal unstage actions", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await unstageProjectWorktreePath("p1", "w1", "README.md");

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/w1/git/unstage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "README.md",
          }),
        },
      );
    });
  });

  describe("getProjectWorktreeGitDiff", () => {
    it("includes originalPath and commitId when provided", async () => {
      const mockDiff = {
        path: "renamed.md",
        scope: "commit",
        originalPath: "README.md",
        commitId: "abcdef123456",
        leftLabel: "Parent",
        rightLabel: "Commit",
        leftContent: "hello\n",
        rightContent: "updated\n",
        language: "markdown",
        readOnly: true,
        modifiedVersionToken: null,
        unsupportedReason: null,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockDiff),
        }),
      );

      const result = await getProjectWorktreeGitDiff(
        "p1",
        "w1",
        "renamed.md",
        "commit",
        "README.md",
        "abcdef123456",
      );

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/p1/worktrees/w1/git/diff?path=renamed.md&scope=commit&originalPath=README.md&commitId=abcdef123456",
      );
      expect(result).toEqual(mockDiff);
    });
  });

  describe("listFiles", () => {
    it("fetches from /api/files with default params", async () => {
      const mockResponse = {
        path: "/home/user",
        entries: [{ name: "projects", isGitRepo: false }],
        homeDir: "/home/user",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await listFiles();
      expect(fetch).toHaveBeenCalledWith("/api/files?");
      expect(result).toEqual(mockResponse);
    });

    it("passes path and showHidden params", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              path: "/tmp",
              entries: [],
              homeDir: "/home/user",
            }),
        }),
      );

      await listFiles("/tmp", true);
      expect(fetch).toHaveBeenCalledWith(
        "/api/files?path=%2Ftmp&showHidden=true",
      );
    });

    it("throws readable error for 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ message: "Directory not found" }),
        }),
      );

      await expect(listFiles("/nope")).rejects.toThrow("Directory not found");
    });

    it("throws readable error for 403", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ message: "Permission denied" }),
        }),
      );

      await expect(listFiles("/secret")).rejects.toThrow("Permission denied");
    });
  });

  describe("worktree file APIs", () => {
    it("propagates backend denied-path messages for file content", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              message: "Only files inside this worktree can be opened.",
            }),
        }),
      );

      await expect(
        getProjectWorktreeFileContent("p1", "w1", "escape-link"),
      ).rejects.toThrow("Only files inside this worktree can be opened.");
    });

    it("propagates backend denied-path messages for file saves", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              message: "This path resolves outside the allowed roots.",
            }),
        }),
      );

      await expect(
        saveProjectWorktreeFileContent(
          "p1",
          "w1",
          "escape-link",
          "test",
          "token-1",
        ),
      ).rejects.toThrow("This path resolves outside the allowed roots.");
    });

    it("propagates backend denied-path messages for git diff", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              message: "Only files inside this worktree can be opened.",
            }),
        }),
      );

      await expect(
        getProjectWorktreeGitDiff("p1", "w1", "escape-link", "unstaged"),
      ).rejects.toThrow("Only files inside this worktree can be opened.");
    });

    it("lists worktree files from the expected route", async () => {
      const mockResponse = {
        generation: 1,
        path: "",
        entries: [
          {
            name: "README.md",
            path: "README.md",
            kind: "file",
            isSymlink: false,
          },
        ],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await listProjectWorktreeFiles("p1", "w1");
      expect(fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees/w1/files");
      expect(result).toEqual(mockResponse);
    });
  });

  describe("terminalWsUrl", () => {
    it("constructs ws:// URL with tabId param", () => {
      const url = terminalWsUrl("tab-1");
      expect(url).toBe("ws://localhost:5173/api/terminal/ws?tabId=tab-1");
    });

    it("constructs wss:// URL for https: protocol", () => {
      vi.stubGlobal("location", {
        protocol: "https:",
        host: "example.com",
      });

      const url = terminalWsUrl("tab-2");
      expect(url).toBe("wss://example.com/api/terminal/ws?tabId=tab-2");
    });
  });

  describe("listTabs", () => {
    it("fetches from /api/tabs", async () => {
      const mockTabs = [
        {
          id: "t1",
          sessionId: "default",
          worktreeId: "w1",
          label: "Terminal 1",
          type: "terminal",
          position: 1.0,
          createdAt: 1000,
          preview: false,
        },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTabs),
        }),
      );

      const result = await listTabs();
      expect(fetch).toHaveBeenCalledWith("/api/tabs");
      expect(result).toEqual(mockTabs);
    });
  });

  describe("createTab", () => {
    it("sends POST with type and worktreeId in body", async () => {
      const mockTab = {
        id: "t1",
        sessionId: "default",
        worktreeId: "w1",
        label: "Terminal 1",
        type: "terminal",
        position: 1.0,
        createdAt: 1000,
        preview: false,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTab),
        }),
      );

      const result = await createTab({
        type: "terminal",
        worktreeId: "w1",
      });
      expect(fetch).toHaveBeenCalledWith("/api/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "terminal", worktreeId: "w1" }),
      });
      expect(result).toEqual(mockTab);
    });

    it("surfaces API error messages on failed tab creation", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              message: "commitId is required for commit diffs.",
            }),
        }),
      );

      await expect(
        createTab({
          type: "git_diff",
          worktreeId: "w1",
          path: "README.md",
          scope: "commit",
          preview: true,
        }),
      ).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 400,
        message: "commitId is required for commit diffs.",
        serverMessage: "commitId is required for commit diffs.",
        method: "POST",
        path: "/api/tabs",
      });
    });
  });

  describe("deleteTab", () => {
    it("sends DELETE to /api/tabs/:id", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
        }),
      );

      await deleteTab("t1");
      expect(fetch).toHaveBeenCalledWith("/api/tabs/t1", {
        method: "DELETE",
      });
    });

    it("tolerates 404 (already gone)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      // Should not throw
      await deleteTab("t1");
    });
  });

  describe("updateTab", () => {
    it("sends PATCH with body", async () => {
      const mockTab = {
        id: "t1",
        sessionId: "default",
        worktreeId: "w1",
        label: "My Shell",
        type: "terminal",
        position: 1.0,
        createdAt: 1000,
        preview: false,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTab),
        }),
      );

      const result = await updateTab("t1", {
        customLabel: "My Shell",
      });
      expect(fetch).toHaveBeenCalledWith("/api/tabs/t1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customLabel: "My Shell" }),
      });
      expect(result).toEqual(mockTab);
    });
  });

  describe("getSettings", () => {
    it("fetches from /api/settings and returns JSON", async () => {
      const mockSettings = {
        settings: {
          appearance: {
            colorScheme: "dark",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
          terminal: {
            fontSource: "default",
            systemFontFamily: "",
            bundledFont: "jetbrainsmono-nf",
            fontSize: 14,
            smartTabNaming: true,
            escapeSequenceTitles: true,
          },
          editor: {
            lightEditorTheme: "hubris-light",
            darkEditorTheme: "hubris-dark",
          },
          worktree: {
            locationMode: "dataDir",
          },
        },
        generation: "123",
        status: okStatus,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockSettings),
        }),
      );

      const result = await getSettings();
      expect(fetch).toHaveBeenCalledWith("/api/settings");
      expect(result).toEqual(mockSettings);
    });

    it("throws on non-OK response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(getSettings()).rejects.toThrow("500");
    });
  });

  describe("patchSettings", () => {
    it("sends PATCH with only modified fields", async () => {
      const response = {
        settings: {
          appearance: {
            colorScheme: "dark",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
          terminal: {
            fontSource: "default",
            systemFontFamily: "",
            bundledFont: "jetbrainsmono-nf",
            fontSize: 14,
            smartTabNaming: true,
            escapeSequenceTitles: true,
          },
          editor: {
            lightEditorTheme: "hubris-light",
            darkEditorTheme: "hubris-dark",
          },
          worktree: {
            locationMode: "dataDir",
          },
        },
        generation: "124",
        status: okStatus,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(response),
        }),
      );

      const result = await patchSettings({
        appearance: { colorScheme: "dark" },
      });

      expect(fetch).toHaveBeenCalledWith("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appearance: { colorScheme: "dark" },
        }),
      });
      expect(result).toEqual(response);
    });

    it("throws on non-OK PATCH response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(
        patchSettings({ terminal: { fontSize: 16 } }),
      ).rejects.toThrow("500");
    });

    it("throws a status-carrying error for non-OK PATCH responses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
        }),
      );

      await expect(
        patchSettings({ terminal: { fontSize: 16 } }),
      ).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 409,
      });
    });
  });

  describe("replaceSettings", () => {
    it("sends PUT with a full settings document", async () => {
      const payload = {
        appearance: {
          colorScheme: "auto" as const,
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "bundled" as const,
          systemFontFamily: "",
          bundledFont: "hack-nf",
          fontSize: 16,
          clientScrollbackRows: 10_000,
          serverScrollbackBytes: 256 * 1024,
          smartTabNaming: true,
          escapeSequenceTitles: true,
          sendKeybindingsToShell: false,
        },
        editor: {
          lightEditorTheme: "hubris-light",
          darkEditorTheme: "hubris-dark",
        },
        worktree: {
          locationMode: "repoLocalDotHubris" as const,
        },
        experimental: {
          chatEnabled: false,
        },
        vscode: {
          runtime: "vscodeCli" as const,
        },
        chat: {
          idleTimeoutMinutes: 5,
          uiStyle: "classic" as const,
          copilotkitThemeMode: "hubris" as const,
        },
      };
      const response = {
        settings: payload,
        generation: "200",
        status: okStatus,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(response),
        }),
      );

      const result = await replaceSettings(payload);

      expect(fetch).toHaveBeenCalledWith("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(result).toEqual(response);
    });

    it("throws on non-OK PUT response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(
        replaceSettings({
          appearance: {
            colorScheme: "auto",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
          terminal: {
            fontSource: "default",
            systemFontFamily: "",
            bundledFont: "jetbrainsmono-nf",
            fontSize: 14,
            clientScrollbackRows: 10_000,
            serverScrollbackBytes: 256 * 1024,
            smartTabNaming: true,
            escapeSequenceTitles: true,
            sendKeybindingsToShell: false,
          },
          editor: {
            lightEditorTheme: "hubris-light",
            darkEditorTheme: "hubris-dark",
          },
          worktree: {
            locationMode: "dataDir",
          },
          experimental: {
            chatEnabled: false,
          },
          vscode: {
            runtime: "vscodeCli",
          },
          chat: {
            idleTimeoutMinutes: 5,
            uiStyle: "classic" as const,
            copilotkitThemeMode: "hubris" as const,
          },
        }),
      ).rejects.toThrow("500");
    });

    it("throws a status-carrying error for non-OK PUT responses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
        }),
      );

      await expect(
        replaceSettings({
          appearance: {
            colorScheme: "auto",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
          terminal: {
            fontSource: "default",
            systemFontFamily: "",
            bundledFont: "jetbrainsmono-nf",
            fontSize: 14,
            clientScrollbackRows: 10_000,
            serverScrollbackBytes: 256 * 1024,
            smartTabNaming: true,
            escapeSequenceTitles: true,
            sendKeybindingsToShell: false,
          },
          editor: {
            lightEditorTheme: "hubris-light",
            darkEditorTheme: "hubris-dark",
          },
          worktree: {
            locationMode: "dataDir",
          },
          experimental: {
            chatEnabled: false,
          },
          vscode: {
            runtime: "vscodeCli",
          },
          chat: {
            idleTimeoutMinutes: 5,
            uiStyle: "classic" as const,
            copilotkitThemeMode: "hubris" as const,
          },
        }),
      ).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 409,
      });
    });
  });
});
