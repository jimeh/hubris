// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiStatusError } from "@/lib/api";
import type { EventHandler, SseEventName } from "@/lib/events";

const mockSaveProjectWorktreeFileContent = vi.fn();
const mockGetProjectWorktreeGitDiff = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeGitDiff: (...args: unknown[]) =>
      mockGetProjectWorktreeGitDiff(...args),
    saveProjectWorktreeFileContent: (...args: unknown[]) =>
      mockSaveProjectWorktreeFileContent(...args),
  };
});

class MockEventClient {
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<unknown>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);
    return () =>
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit(event: SseEventName, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }
}

let mockEvents: MockEventClient;

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) mockEvents = new MockEventClient();
      return mockEvents;
    },
  };
});

async function getStore() {
  const mod = await import("./gitDiffTabs");
  mod.resetGitDiffStoreForTests();
  mod.initializeGitDiffStore();
  return mod;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const diffTab = {
  id: "diff-1",
  label: "README.md",
  position: 1,
  worktree_id: "w1",
  session_id: "default",
  type: "git_diff" as const,
  created_at: 0,
  preview: false,
  path: "README.md",
  scope: "unstaged" as const,
  original_path: null,
};

const editableDiffResponse = {
  path: "README.md",
  scope: "unstaged" as const,
  original_path: null,
  left_label: "Index",
  right_label: "Working Tree",
  left_content: "hello\n",
  right_content: "hello world\n",
  language: "markdown",
  read_only: false,
  modified_version_token: "v1",
  unsupported_reason: null,
};

describe("gitDiffTabs store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockGetProjectWorktreeGitDiff.mockReset();
    mockSaveProjectWorktreeFileContent.mockReset();
    mockEvents = new MockEventClient();
  });

  it("keeps newer draft edits dirty when an older save resolves", async () => {
    const { useGitDiffStore } = await getStore();
    mockSaveProjectWorktreeFileContent.mockImplementation(async () => {
      useGitDiffStore.getState().updateDraft("diff-1", "hello again\n");
      return { version_token: "v2" };
    });

    useGitDiffStore.setState({
      sessions: {
        "diff-1": {
          tabId: "diff-1",
          path: "README.md",
          originalPath: null,
          scope: "unstaged",
          originalContent: "hello\n",
          draft: "hello world\n",
          savedContent: "hello\n",
          modifiedVersionToken: "v1",
          language: "markdown",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
    });

    await useGitDiffStore.getState().save("p1", "w1", "diff-1");

    expect(useGitDiffStore.getState().sessions["diff-1"]).toMatchObject({
      draft: "hello again\n",
      savedContent: "hello world\n",
      modifiedVersionToken: "v2",
      dirty: true,
      externalChange: false,
      saveStatus: "idle",
      error: null,
    });
  }, 10_000);

  it("marks external changes on save conflict without dropping the latest draft", async () => {
    const { useGitDiffStore } = await getStore();
    mockSaveProjectWorktreeFileContent.mockRejectedValue(
      new ApiStatusError(409, "conflict"),
    );

    useGitDiffStore.setState({
      sessions: {
        "diff-1": {
          tabId: "diff-1",
          path: "README.md",
          originalPath: null,
          scope: "unstaged",
          originalContent: "hello\n",
          draft: "hello world\n",
          savedContent: "hello\n",
          modifiedVersionToken: "v1",
          language: "markdown",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
    });

    await expect(
      useGitDiffStore.getState().save("p1", "w1", "diff-1"),
    ).rejects.toThrow("conflict");

    expect(useGitDiffStore.getState().sessions["diff-1"]).toMatchObject({
      draft: "hello world\n",
      savedContent: "hello\n",
      dirty: true,
      externalChange: true,
      saveStatus: "error",
      error: "conflict",
    });
  });

  it("reloads clean editable diffs on matching worktree file updates", async () => {
    const { useGitDiffStore } = await getStore();
    const reloadRequest = deferred<typeof editableDiffResponse>();
    mockGetProjectWorktreeGitDiff.mockImplementation(
      () => reloadRequest.promise,
    );

    const { useTabStore } = await import("./tabs");
    useTabStore.setState({
      tabs: [diffTab],
    });
    useGitDiffStore.setState({
      sessions: {
        "diff-1": {
          tabId: "diff-1",
          path: "README.md",
          originalPath: null,
          scope: "unstaged",
          originalContent: "hello\n",
          draft: "hello world\n",
          savedContent: "hello world\n",
          modifiedVersionToken: "v1",
          language: "markdown",
          readOnly: false,
          unsupportedReason: null,
          dirty: false,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
    });

    mockEvents.emit("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      changed_paths: ["README.md"],
      listing_paths: [],
    });

    reloadRequest.resolve({
      ...editableDiffResponse,
      right_content: "hello changed\n",
      modified_version_token: "v2",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useGitDiffStore.getState().sessions["diff-1"]).toMatchObject({
      draft: "hello changed\n",
      savedContent: "hello changed\n",
      modifiedVersionToken: "v2",
      externalChange: false,
    });
  });

  it("marks dirty editable diffs as externally changed on matching worktree file updates", async () => {
    const { useGitDiffStore } = await getStore();
    const { useTabStore } = await import("./tabs");
    useTabStore.setState({
      tabs: [diffTab],
    });
    useGitDiffStore.setState({
      sessions: {
        "diff-1": {
          tabId: "diff-1",
          path: "README.md",
          originalPath: null,
          scope: "unstaged",
          originalContent: "hello\n",
          draft: "dirty\n",
          savedContent: "hello world\n",
          modifiedVersionToken: "v1",
          language: "markdown",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
    });

    mockEvents.emit("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      changed_paths: ["README.md"],
      listing_paths: [],
    });

    expect(useGitDiffStore.getState().sessions["diff-1"]?.externalChange).toBe(
      true,
    );
    expect(mockGetProjectWorktreeGitDiff).not.toHaveBeenCalled();
  });
});
