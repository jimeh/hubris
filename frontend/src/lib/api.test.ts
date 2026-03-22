// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock location for terminalWsUrl
vi.stubGlobal("location", {
  protocol: "http:",
  host: "localhost:5173",
});

// Import after mocking globals
const {
  listProjects,
  addProject,
  updateProject,
  reorderProjects,
  deleteProject,
  listProjectWorktreeStartPoints,
  createProjectWorktree,
  getProjectWorktreeCommitDetails,
  getProjectWorktreeGitStatus,
  stageProjectWorktreePath,
  unstageProjectWorktreePath,
  terminalWsUrl,
  listFiles,
  listTabs,
  createTab,
  deleteTab,
  updateTab,
  getSettings,
  patchSettings,
  replaceSettings,
  resetApiStateForTests,
} = await import("./api");

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
    it("sends PUT with project_ids", async () => {
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
        body: JSON.stringify({ project_ids: ["p2", "p1"] }),
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

    it("sends delete_managed_worktrees for managed deletion", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject("abc-123", { deleteManagedWorktrees: true });

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/abc-123?delete_managed_worktrees=true",
        {
          method: "DELETE",
        },
      );
    });

    it("sends both delete_managed_worktrees and force when forcing deletion", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject("abc-123", {
        deleteManagedWorktrees: true,
        force: true,
      });

      expect(fetch).toHaveBeenCalledWith(
        "/api/projects/abc-123?delete_managed_worktrees=true&force=true",
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

      await expect(deleteProject("abc-123")).rejects.toThrow("500");
    });
  });

  describe("listProjectWorktreeStartPoints", () => {
    it("fetches start points for a project", async () => {
      const mockResponse = {
        start_points: [
          {
            value: "main",
            sha: "abc123",
            local_ref: "main",
            remote_refs: ["origin/main"],
          },
        ],
        default_start_point: "main",
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
        project_id: "p1",
        name: "feature-test",
        path: "/tmp/w1",
        branch: "feature-test",
        source_ref: "origin/main",
        is_local: false,
        missing_on_disk: false,
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
          start_point: "origin/main",
          source_ref: "origin/main",
        }),
      });
      expect(result).toEqual(mockWorktree);
    });

    it("omits start_point when not provided", async () => {
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
        source_ref: "origin/main",
        unstaged_files: [],
        staged_files: [],
        ahead_count: 0,
        ahead_commits: [],
        comparison_available: true,
        comparison_error: null,
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
        short_id: "abcdef1",
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
        files: [{ path: "src/main.ts", change_type: "modified" }],
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
        }),
      );

      await expect(
        getProjectWorktreeCommitDetails("p1", "w1", "deadbeef"),
      ).rejects.toThrow("Commit not found");
    });
  });

  describe("worktree git path actions", () => {
    it("sends original_path when staging a renamed or copied path", async () => {
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
            original_path: "old/source.txt",
          }),
        },
      );
    });

    it("omits original_path for normal unstage actions", async () => {
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

  describe("listFiles", () => {
    it("fetches from /api/files with default params", async () => {
      const mockResponse = {
        path: "/home/user",
        entries: [{ name: "projects", is_git_repo: false }],
        home_dir: "/home/user",
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

    it("passes path and show_hidden params", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              path: "/tmp",
              entries: [],
              home_dir: "/home/user",
            }),
        }),
      );

      await listFiles("/tmp", true);
      expect(fetch).toHaveBeenCalledWith(
        "/api/files?path=%2Ftmp&show_hidden=true",
      );
    });

    it("throws readable error for 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
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
        }),
      );

      await expect(listFiles("/secret")).rejects.toThrow("Permission denied");
    });
  });

  describe("terminalWsUrl", () => {
    it("constructs ws:// URL with tab_id param", () => {
      const url = terminalWsUrl("tab-1");
      expect(url).toBe("ws://localhost:5173/api/terminal/ws?tab_id=tab-1");
    });

    it("constructs wss:// URL for https: protocol", () => {
      vi.stubGlobal("location", {
        protocol: "https:",
        host: "example.com",
      });

      const url = terminalWsUrl("tab-2");
      expect(url).toBe("wss://example.com/api/terminal/ws?tab_id=tab-2");
    });
  });

  describe("listTabs", () => {
    it("fetches from /api/tabs", async () => {
      const mockTabs = [
        {
          id: "t1",
          session_id: "default",
          worktree_id: "w1",
          label: "Terminal 1",
          type: "terminal",
          position: 1.0,
          created_at: 1000,
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
    it("sends POST with type and worktree_id in body", async () => {
      const mockTab = {
        id: "t1",
        session_id: "default",
        worktree_id: "w1",
        label: "Terminal 1",
        type: "terminal",
        position: 1.0,
        created_at: 1000,
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
        worktree_id: "w1",
      });
      expect(fetch).toHaveBeenCalledWith("/api/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "terminal", worktree_id: "w1" }),
      });
      expect(result).toEqual(mockTab);
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
        session_id: "default",
        worktree_id: "w1",
        label: "My Shell",
        type: "terminal",
        position: 1.0,
        created_at: 1000,
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
        label: "My Shell",
      });
      expect(fetch).toHaveBeenCalledWith("/api/tabs/t1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "My Shell" }),
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
        },
        worktree: {
          locationMode: "repoLocalDotHubris" as const,
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
          },
          worktree: {
            locationMode: "dataDir",
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
          },
          worktree: {
            locationMode: "dataDir",
          },
        }),
      ).rejects.toMatchObject({
        name: "ApiStatusError",
        status: 409,
      });
    });
  });
});
