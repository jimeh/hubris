// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { EventHandler, SseEventName } from "@/lib/events";
import {
  initializeProjectStore,
  resetProjectStoreForTests,
} from "@/lib/stores/projects";
import { resetTabStoreForTests } from "@/lib/stores/tabs";
import {
  resetVscodeWorkbenchStoreForTests,
  useVscodeWorkbenchStore,
} from "@/lib/stores/vscodeWorkbench";
import {
  initializeWorktreeStore,
  resetWorktreeStoreForTests,
} from "@/lib/stores/worktrees";
import type { Project, Worktree } from "@/lib/types";
import AppSidebarRoot from "./AppSidebarRoot";

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

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
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
    source_ref: overrides.source_ref ?? null,
    ui_mode: overrides.ui_mode ?? "hubris",
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
    position: overrides.position ?? 1,
  };
}

function renderSidebar() {
  resetProjectStoreForTests();
  resetWorktreeStoreForTests();
  resetTabStoreForTests();
  resetVscodeWorkbenchStoreForTests();
  initializeProjectStore();
  initializeWorktreeStore();

  return render(
    <SidebarProvider defaultOpen>
      <AppSidebarRoot />
    </SidebarProvider>,
  );
}

describe("AppSidebarRoot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it("renders project worktrees from snapshot state", () => {
    const local = makeWorktree({
      id: "w-local",
      project_id: "p1",
      name: "local",
      is_local: true,
      position: 1,
    });

    renderSidebar();

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

    expect(screen.getByText("Devbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
    expect(screen.getByText("feature-a")).toBeInTheDocument();
  });

  it("rerenders removals from worktree_deleted and project_removed", () => {
    const local = makeWorktree({
      id: "w-local",
      project_id: "p1",
      name: "local",
      is_local: true,
      position: 1,
    });

    renderSidebar();

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

    expect(screen.getByText("feature-a")).toBeInTheDocument();

    act(() => {
      mockEvents.emit("worktree_deleted", {
        project_id: "p1",
        worktree_id: "w-feature",
      });
    });

    expect(screen.queryByText("feature-a")).not.toBeInTheDocument();

    act(() => {
      mockEvents.emit("project_removed", {
        project_id: "p1",
      });
    });

    expect(screen.queryByText("Devbox")).not.toBeInTheDocument();
  });

  it("applies the lower mobile sidebar panel z-layer class", () => {
    renderSidebar();

    const sidebarContainer = document.querySelector(
      '[data-slot="sidebar-container"]',
    );

    expect(sidebarContainer).toHaveClass("z-40");
    expect(sidebarContainer).toHaveClass("md:z-10");
  });

  it("shows a blue-dot indicator for retained VS Code workbenches", () => {
    const local = makeWorktree({
      id: "w-local",
      project_id: "p1",
      name: "local",
      is_local: true,
      position: 1,
    });

    renderSidebar();

    act(() => {
      useVscodeWorkbenchStore.getState().markLoaded("w-feature");
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

    expect(screen.getByText("feature-a")).toBeInTheDocument();
    expect(screen.getByLabelText("VS Code workbench loaded")).toBeVisible();
    expect(screen.getAllByLabelText("VS Code workbench loaded")).toHaveLength(
      1,
    );
  });

  it("collapses project actions until hover or focus within", () => {
    renderSidebar();

    act(() => {
      mockEvents.emit("snapshot", {
        projects: [makeProject({ id: "p1", name: "Devbox" })],
        worktrees: {
          p1: [
            makeWorktree({
              id: "w-local",
              project_id: "p1",
              name: "local",
              is_local: true,
              position: 1,
            }),
          ],
        },
        project_errors: {},
      });
    });

    const newWorktreeButton = screen.getByRole("button", {
      name: "New worktree",
    });
    const actionLayout = newWorktreeButton.parentElement;
    const actionContainer = actionLayout?.parentElement;

    expect(actionContainer).toHaveClass("max-w-0");
    expect(actionContainer).toHaveClass("overflow-hidden");
    expect(actionContainer).toHaveClass("pointer-events-none");
    expect(actionContainer).toHaveClass("opacity-0");
    expect(actionContainer).toHaveClass("group-hover/project-row:max-w-24");
    expect(actionContainer).toHaveClass("group-hover/project-row:opacity-100");
    expect(actionContainer).toHaveClass(
      "group-focus-within/project-row:max-w-24",
    );
    expect(actionContainer).toHaveClass(
      "group-focus-within/project-row:opacity-100",
    );
    expect(actionContainer).toHaveClass(
      "group-has-data-[state=open]/project-row:max-w-24",
    );
    expect(actionContainer).toHaveClass(
      "group-has-data-[state=open]/project-row:opacity-100",
    );
    expect(actionLayout).toHaveClass("ml-auto");
  });
});
