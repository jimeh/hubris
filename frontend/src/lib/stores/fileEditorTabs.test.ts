// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiStatusError } from "@/lib/api";
import type { EventHandler, SseEventName } from "@/lib/events";

const mockSaveProjectWorktreeFileContent = vi.fn();
const mockGetProjectWorktreeFileContent = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeFileContent: (...args: unknown[]) =>
      mockGetProjectWorktreeFileContent(...args),
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
  const mod = await import("./fileEditorTabs");
  mod.resetFileEditorStoreForTests();
  mod.initializeFileEditorStore();
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

describe("fileEditorTabs store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockGetProjectWorktreeFileContent.mockReset();
    mockSaveProjectWorktreeFileContent.mockReset();
    mockEvents = new MockEventClient();
  });

  it("keeps newer draft edits dirty when an older save resolves", async () => {
    const { useFileEditorStore } = await getStore();
    mockSaveProjectWorktreeFileContent.mockImplementation(async () => {
      useFileEditorStore.getState().updateDraft("file-1", "draft-2");
      return { version_token: "v2" };
    });

    useFileEditorStore.setState({
      sessions: {
        "file-1": {
          tabId: "file-1",
          path: "src/main.ts",
          draft: "draft-1",
          savedContent: "saved-0",
          versionToken: "v1",
          language: "typescript",
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

    const savePromise = useFileEditorStore
      .getState()
      .save("p1", "w1", "file-1");

    await savePromise;

    expect(useFileEditorStore.getState().sessions["file-1"]).toMatchObject({
      draft: "draft-2",
      savedContent: "draft-1",
      versionToken: "v2",
      dirty: true,
      externalChange: false,
      saveStatus: "idle",
      error: null,
    });
  }, 10_000);

  it("does not recreate a discarded session when save finishes later", async () => {
    const { useFileEditorStore } = await getStore();
    const saveRequest = deferred<{ version_token: string }>();
    mockSaveProjectWorktreeFileContent.mockImplementation(
      () => saveRequest.promise,
    );

    useFileEditorStore.setState({
      sessions: {
        "file-1": {
          tabId: "file-1",
          path: "src/main.ts",
          draft: "draft-1",
          savedContent: "saved-0",
          versionToken: "v1",
          language: "typescript",
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

    const savePromise = useFileEditorStore
      .getState()
      .save("p1", "w1", "file-1");

    useFileEditorStore.getState().discardSession("file-1");
    saveRequest.resolve({ version_token: "v2" });
    await savePromise;

    expect(useFileEditorStore.getState().sessions["file-1"]).toBeUndefined();
  });

  it("marks external changes on save conflict without dropping the latest draft", async () => {
    const { useFileEditorStore } = await getStore();
    mockSaveProjectWorktreeFileContent.mockRejectedValue(
      new ApiStatusError(409, "conflict"),
    );

    useFileEditorStore.setState({
      sessions: {
        "file-1": {
          tabId: "file-1",
          path: "src/main.ts",
          draft: "draft-1",
          savedContent: "saved-0",
          versionToken: "v1",
          language: "typescript",
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
      useFileEditorStore.getState().save("p1", "w1", "file-1"),
    ).rejects.toThrow("conflict");

    expect(useFileEditorStore.getState().sessions["file-1"]).toMatchObject({
      draft: "draft-1",
      savedContent: "saved-0",
      dirty: true,
      externalChange: true,
      saveStatus: "error",
      error: "conflict",
    });
  });

  it("preserves session object identity when snapshot pruning is a no-op", async () => {
    const { useFileEditorStore } = await getStore();
    const session = {
      tabId: "file-1",
      path: "src/main.ts",
      draft: "draft-1",
      savedContent: "saved-0",
      versionToken: "v1",
      language: "typescript",
      readOnly: false,
      unsupportedReason: null,
      dirty: true,
      externalChange: false,
      loadStatus: "loaded" as const,
      saveStatus: "idle" as const,
      error: null,
    };
    useFileEditorStore.setState({
      sessions: {
        "file-1": session,
      },
    });

    const previousSessions = useFileEditorStore.getState().sessions;
    mockEvents.emit("snapshot", {
      tabs: [
        {
          id: "file-1",
          type: "file",
        },
        {
          id: "diff-1",
          type: "git_diff",
        },
      ],
    });

    expect(useFileEditorStore.getState().sessions).toBe(previousSessions);
    expect(useFileEditorStore.getState().sessions["file-1"]).toBe(session);
  });

  it("prunes only stale file sessions on snapshot", async () => {
    const { useFileEditorStore } = await getStore();
    const keptSession = {
      tabId: "file-1",
      path: "src/main.ts",
      draft: "draft-1",
      savedContent: "saved-0",
      versionToken: "v1",
      language: "typescript",
      readOnly: false,
      unsupportedReason: null,
      dirty: true,
      externalChange: false,
      loadStatus: "loaded" as const,
      saveStatus: "idle" as const,
      error: null,
    };
    useFileEditorStore.setState({
      sessions: {
        "file-1": keptSession,
        "file-2": {
          ...keptSession,
          tabId: "file-2",
          path: "src/old.ts",
        },
      },
    });

    mockEvents.emit("snapshot", {
      tabs: [
        {
          id: "file-1",
          type: "file",
        },
      ],
    });

    const nextSessions = useFileEditorStore.getState().sessions;
    expect(Object.keys(nextSessions)).toEqual(["file-1"]);
    expect(nextSessions["file-1"]).toBe(keptSession);
    expect(nextSessions["file-2"]).toBeUndefined();
  });

  it("does not recreate a discarded session when reload fails later", async () => {
    const { useFileEditorStore } = await getStore();
    const { useTabStore } = await import("./tabs");
    const reloadRequest = deferred<unknown>();
    mockGetProjectWorktreeFileContent.mockImplementation(
      () => reloadRequest.promise,
    );

    useTabStore.setState({
      tabs: [
        {
          id: "file-1",
          label: "main.ts",
          position: 1,
          worktree_id: "w1",
          session_id: "default",
          type: "file",
          created_at: 0,
          preview: false,
          path: "src/main.ts",
        },
      ],
    });
    useFileEditorStore.setState({
      sessions: {
        "file-1": {
          tabId: "file-1",
          path: "src/main.ts",
          draft: "draft-1",
          savedContent: "saved-0",
          versionToken: "v1",
          language: "typescript",
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

    const reloadPromise = useFileEditorStore
      .getState()
      .reload("p1", "w1", "file-1");

    useFileEditorStore.getState().discardSession("file-1");
    reloadRequest.reject(new Error("boom"));
    await reloadPromise;

    expect(useFileEditorStore.getState().sessions["file-1"]).toBeUndefined();
  });
});
