// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiStatusError } from "@/lib/api";

const mockSaveProjectWorktreeFileContent = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeFileContent: vi.fn(),
    saveProjectWorktreeFileContent: (...args: unknown[]) =>
      mockSaveProjectWorktreeFileContent(...args),
  };
});

async function getStore() {
  const mod = await import("./fileEditorTabs");
  mod.resetFileEditorStoreForTests();
  return mod;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("fileEditorTabs store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockSaveProjectWorktreeFileContent.mockReset();
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
});
