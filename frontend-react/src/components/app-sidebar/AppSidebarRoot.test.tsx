// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "$lib/events";
import type { Project, Worktree } from "$lib/types";

vi.mock("./SidebarDialogs", () => ({
  default: () => null,
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
      if (!mockEvents) {
        mockEvents = new MockEventClient();
      }
      return mockEvents;
    },
  };
});

function makeProject(
  overrides: Partial<Project> & { id: string; name: string },
): Project {
  return {
    id: overrides.id,
    name: overrides.name,
    path: overrides.path ?? `/tmp/${overrides.id}`,
    position: overrides.position ?? 1,
    git_error: overrides.git_error,
  };
}

function makeWorktree(
  overrides: Partial<Worktree> & {
    id: string;
    project_id: string;
    name: string;
  },
): Worktree {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name,
    path: overrides.path ?? `/tmp/${overrides.name}`,
    branch: overrides.branch ?? overrides.name,
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
    position: overrides.position ?? 1,
  };
}

async function renderSidebar() {
  const projectStore = await import("$lib/stores/projects");
  const worktreeStore = await import("$lib/stores/worktrees");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { default: AppSidebarRoot } = await import("./AppSidebarRoot");

  projectStore.resetProjectStoreForTests();
  worktreeStore.resetWorktreeStoreForTests();
  projectStore.initializeProjectStore();
  worktreeStore.initializeWorktreeStore();

  return render(
    <SidebarProvider defaultOpen>
      <AppSidebarRoot />
    </SidebarProvider>,
  );
}

describe("AppSidebarRoot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it("rerenders project worktrees when project_worktrees_updated arrives", async () => {
    const local = makeWorktree({
      id: "w-local",
      project_id: "p1",
      name: "local",
      is_local: true,
      position: 1,
    });

    await renderSidebar();

    act(() => {
      mockEvents.emit("snapshot", {
        projects: [makeProject({ id: "p1", name: "Devbox" })],
        worktrees: { p1: [local] },
        project_errors: {},
      });
    });

    await screen.findByText("Devbox");
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();

    act(() => {
      mockEvents.emit("project_worktrees_updated", {
        project_id: "p1",
        worktrees: [
          local,
          makeWorktree({
            id: "w-feature",
            project_id: "p1",
            name: "feature-a",
            position: 2,
          }),
        ],
        git_error: null,
      });
    });

    expect(await screen.findByText("feature-a")).toBeInTheDocument();
  });

  it("rerenders removals from worktree_deleted and project_removed", async () => {
    const local = makeWorktree({
      id: "w-local",
      project_id: "p1",
      name: "local",
      is_local: true,
      position: 1,
    });

    await renderSidebar();

    act(() => {
      mockEvents.emit("snapshot", {
        projects: [makeProject({ id: "p1", name: "Devbox" })],
        worktrees: {
          p1: [
            local,
            makeWorktree({
              id: "w-feature",
              project_id: "p1",
              name: "feature-a",
              position: 2,
            }),
          ],
        },
        project_errors: {},
      });
    });

    await screen.findByText("feature-a");

    act(() => {
      mockEvents.emit("worktree_deleted", {
        project_id: "p1",
        worktree_id: "w-feature",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("feature-a")).not.toBeInTheDocument();
    });

    act(() => {
      mockEvents.emit("project_removed", {
        project_id: "p1",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Devbox")).not.toBeInTheDocument();
    });
  });
});
