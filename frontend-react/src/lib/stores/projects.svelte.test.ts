// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "$lib/events";
import type { Project } from "$lib/types";

const mockAddProject = vi.fn();
const mockDeleteProject = vi.fn();
const mockReorderProjects = vi.fn();

vi.mock("$lib/api", () => ({
  addProject: (...args: unknown[]) => mockAddProject(...args),
  deleteProject: (...args: unknown[]) => mockDeleteProject(...args),
  reorderProjects: (...args: unknown[]) => mockReorderProjects(...args),
  updateProject: vi.fn(),
}));

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

vi.mock("$lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("$lib/events")>("$lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) mockEvents = new MockEventClient();
      return mockEvents;
    },
  };
});

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    id: overrides.id,
    name: overrides.name ?? `Project ${overrides.id}`,
    path: overrides.path ?? `/tmp/${overrides.id}`,
    position: overrides.position ?? 1,
    git_error: overrides.git_error,
  };
}

async function getStore() {
  const mod = await import("./projects");
  mod.resetProjectStoreForTests();
  mod.initializeProjectStore();
  return mod;
}

describe("Project store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it("loads projects from snapshot sorted by position", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      projects: [
        makeProject({ id: "a", position: 2 }),
        makeProject({ id: "b", position: 1 }),
      ],
    });

    expect(store.useProjectStore.getState().projects.map((p) => p.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("toggleExpanded persists state", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      projects: [makeProject({ id: "a", position: 1 })],
    });

    expect(store.isProjectExpanded("a")).toBe(true);
    store.useProjectStore.getState().toggleExpanded("a");
    expect(store.isProjectExpanded("a")).toBe(false);
  });

  it("add() inserts project optimistically", async () => {
    const store = await getStore();
    const added = makeProject({ id: "n", position: 1 });
    mockAddProject.mockResolvedValue(added);

    await store.useProjectStore.getState().add("/tmp/n");

    expect(mockAddProject).toHaveBeenCalledWith("/tmp/n");
    expect(store.useProjectStore.getState().projects.map((p) => p.id)).toEqual([
      "n",
    ]);
  });

  it("remove() passes force flag through to API", async () => {
    const store = await getStore();
    mockDeleteProject.mockResolvedValue(undefined);

    await store.useProjectStore.getState().remove("a", true);

    expect(mockDeleteProject).toHaveBeenCalledWith("a", true);
  });

  it("reorder() resequences locally and calls API", async () => {
    const store = await getStore();
    mockReorderProjects.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      projects: [
        makeProject({ id: "a", position: 1 }),
        makeProject({ id: "b", position: 2 }),
        makeProject({ id: "c", position: 3 }),
      ],
    });

    await store.useProjectStore.getState().reorder(["c", "a", "b"]);

    expect(mockReorderProjects).toHaveBeenCalledWith(["c", "a", "b"]);
    expect(store.useProjectStore.getState().projects.map((p) => p.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
