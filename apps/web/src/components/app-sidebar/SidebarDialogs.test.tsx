// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SidebarDialogs from "./SidebarDialogs";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { executeCommand } from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useProjectStore } from "@/lib/stores/projects";

vi.mock("@/lib/commands", () => ({
  executeCommand: vi.fn(),
}));

function makeProject(id: string, name: string) {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    position: 1,
  };
}

describe("SidebarDialogs", () => {
  beforeEach(() => {
    resetBootstrapForTests();
    vi.mocked(executeCommand).mockReset();
    vi.mocked(executeCommand).mockResolvedValue({ status: "success" });
    useProjectStore.setState({
      projects: [makeProject("p1", "Devbox")],
    });
  });

  it("routes remove-only project removal through the command system", async () => {
    useCommandUiStore.setState({
      dialog: {
        projectId: "p1",
        type: "remove-project",
      },
    });

    render(<SidebarDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Remove only" }));

    await waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith({
        args: {
          deleteManagedWorktrees: false,
          projectId: "p1",
        },
        id: "project.remove",
        source: "dialog",
      });
    });
  });

  it("routes delete-managed project removal through the command system", async () => {
    useCommandUiStore.setState({
      dialog: {
        projectId: "p1",
        type: "remove-project",
      },
    });

    render(<SidebarDialogs />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove + delete managed worktrees",
      }),
    );

    await waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith({
        args: {
          deleteManagedWorktrees: true,
          force: undefined,
          projectId: "p1",
        },
        id: "project.remove",
        source: "dialog",
      });
    });
  });

  it("routes force-dialog remove-only through the command system", async () => {
    useCommandUiStore.setState({
      dialog: {
        forceManagedDelete: true,
        projectId: "p1",
        type: "remove-project",
      },
    });

    render(<SidebarDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Remove only" }));

    await waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith({
        args: {
          deleteManagedWorktrees: false,
          projectId: "p1",
        },
        id: "project.remove",
        source: "dialog",
      });
    });
  });

  it("routes force-delete project removal through the command system", async () => {
    useCommandUiStore.setState({
      dialog: {
        forceManagedDelete: true,
        projectId: "p1",
        type: "remove-project",
      },
    });

    render(<SidebarDialogs />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Force remove + delete managed worktrees",
      }),
    );

    await waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith({
        args: {
          deleteManagedWorktrees: true,
          force: true,
          projectId: "p1",
        },
        id: "project.remove",
        source: "dialog",
      });
    });
  });
});
